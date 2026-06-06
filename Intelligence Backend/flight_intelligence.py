import os
import sys
import time
import json
from pathlib import Path

import numpy as np
import requests
import serial
from serial.tools import list_ports

from kmeans_model import DEFAULT_MODEL_PATH, FlightKMeansModel, train_kmeans_model
from security_layer import canonical_telemetry_string, compute_crc32, compute_hmac


SERIAL_PORT = os.getenv("SERIAL_PORT")
BAUD_RATE = int(os.getenv("BAUD_RATE", "115200"))
FLASK_UPDATE_URL = os.getenv("FLASK_UPDATE_URL", "http://127.0.0.1:5000/update")
NODE_ID = os.getenv("NODE_ID", "ESP_RELAY_01")
MODEL_PATH = Path(os.getenv("KMEANS_MODEL_PATH", DEFAULT_MODEL_PATH))
DEVICE_TOKEN = os.getenv("DEVICE_TOKEN", "development-device-token")

FEATURE_NAMES = ("vibration", "temperature", "pressure")
ESP32_BOOT_PREFIXES = (
    "ELF file SHA256",
    "Rebooting",
    "rst:",
    "configsip:",
    "clk_drv:",
    "mode:",
    "load:",
    "entry ",
    "Waiting for data",
    "--- GATEWAY IS ONLINE",
    "SECURE_BOOT_VERIFIED",
)


def load_or_train_model():
    if MODEL_PATH.exists():
        model = FlightKMeansModel.load(MODEL_PATH)
    else:
        model, _metrics = train_kmeans_model()
        model.save(MODEL_PATH)

    if "ANOMALY_THRESHOLD" in os.environ:
        model.threshold = float(os.environ["ANOMALY_THRESHOLD"])
    return model


kmeans_model = load_or_train_model()


ESP32_PORT_MATCHES = (
    "ESP32",
    "CP210",
    "CP210X",
    "SILICON LABS",
    "CH340",
    "CH341",
    "USB SERIAL",
    "USB-SERIAL",
    "USB UART",
)


def find_esp32_gateway():
    """Return an ESP32-looking serial port, with a sensible fallback."""
    ports = list(list_ports.comports())
    if not ports:
        return None

    print("[*] Scanning system serial ports for ESP32 Gateway...")
    for port in ports:
        description = f"{port.description} {port.manufacturer or ''} {port.hwid or ''}".upper()
        if any(match in description for match in ESP32_PORT_MATCHES):
            print(f"[+] Found matching hardware: {port.device} ({port.description})")
            return port.device

    fallback = ports[0]
    print(
        "[!] ESP32 USB chip name not recognized. "
        f"Defaulting to first available port: {fallback.device} ({fallback.description})"
    )
    return fallback.device


def _is_float(value):
    try:
        float(value)
        return True
    except ValueError:
        return False


def is_esp32_boot_line(line):
    return any(line.startswith(prefix) for prefix in ESP32_BOOT_PREFIXES)


def parse_esp_line(line):
    """Convert ESP32 gateway serial telemetry into a node id and feature floats."""
    parts = [value.strip() for value in line.split(",")]

    if len(parts) == 4 and _is_float(parts[1]) and _is_float(parts[2]) and _is_float(parts[3]):
        node_id = parts[0]
        return node_id, float(parts[1]), float(parts[2]), float(parts[3])

    if len(parts) == 3 and all(_is_float(value) for value in parts):
        return NODE_ID, float(parts[0]), float(parts[1]), float(parts[2])

    if len(parts) == 4 and all(_is_float(value) for value in parts[:3]):
        sensor_payload = ",".join(parts[:3])
        expected_crc = compute_crc32(sensor_payload)
        received_crc = parts[3].lower().replace("0x", "")
        if received_crc != expected_crc:
            raise ValueError(
                f"serial CRC mismatch: expected {expected_crc}, received {received_crc}"
            )
        return NODE_ID, float(parts[0]), float(parts[1]), float(parts[2])

    raise ValueError("Expected node_id,vibration,temp,pressure or vibration,temp,pressure[,crc32]")


def anomaly_distance(vibration, temperature, pressure):
    point = np.array([[vibration, temperature, pressure]], dtype=float)
    return float(kmeans_model.distances(point)[0])


def build_payload(node_id, vibration, temperature, pressure):
    prediction = kmeans_model.predict([[vibration, temperature, pressure]])
    confidence = max(0.0, min(100.0, 100.0 * (1.0 - (prediction["cluster_distance"] / (kmeans_model.threshold * 2.0)))))
    payload = {
        "node_id": node_id,
        "vibr_x": vibration,
        "m_temp": temperature,
        "press": pressure,
        "cluster": prediction["cluster"],
        "cluster_distance": prediction["cluster_distance"],
        "ai_confidence": round(confidence, 2),
        "anomaly": bool(prediction["anomaly"]), # Ensure strict boolean formatting for JSON serialization
    }
    canonical = canonical_telemetry_string(payload)
    payload["checksum"] = compute_crc32(canonical)
    payload["signature"] = compute_hmac(canonical)
    return payload


def learn_from_nominal_payload(payload):
    point = [[payload["vibr_x"], payload["m_temp"], payload["press"]]]
    if not kmeans_model.partial_fit_nominal(point):
        return False

    kmeans_model.save(MODEL_PATH)
    return True


def post_to_dashboard(payload):
    headers = {"X-Device-Token": DEVICE_TOKEN}
    response = requests.post(FLASK_UPDATE_URL, json=payload, headers=headers, timeout=2)
    response.raise_for_status()
    return response


def dashboard_alarm_state(response, fallback):
    try:
        response_payload = response.json()
    except ValueError:
        return fallback

    if response.status_code != 200 or response_payload.get("status") != "success":
        return fallback

    return bool(response_payload.get("alarm", response_payload.get("anomaly", fallback)))


def main():
    serial_port = SERIAL_PORT or find_esp32_gateway()
    if not serial_port:
        print(
            "No serial devices detected. Plug in the ESP32 Gateway or set SERIAL_PORT manually.",
            file=sys.stderr,
        )
        return 1

    try:
        ser = serial.Serial(serial_port, BAUD_RATE, timeout=1)
        time.sleep(2) # Allow connection to settle
    except serial.SerialException as exc:
        print(f"Could not open serial port {serial_port}: {exc}", file=sys.stderr)
        return 1

    print(f"Monitoring ESP relay on {serial_port} at {BAUD_RATE} baud...")
    print(f"Posting telemetry to: {FLASK_UPDATE_URL}")
    if FLASK_UPDATE_URL.startswith("http://127.0.0.1") or FLASK_UPDATE_URL.startswith("http://localhost"):
        print("[!] Using local Flask URL. Set FLASK_UPDATE_URL to your Render /update URL when the backend is deployed.")
    print("Expected serial format: node_id,vibration,temp,pressure")

    # Keep track of local state to avoid spamming the serial port continuously
    alarm_active = False

    while True:
        try:
            line = ser.readline().decode("utf-8", errors="replace").strip()
            if not line:
                continue
            if is_esp32_boot_line(line):
                continue

            # Process raw reading and construct secure dashboard payload
            payload = build_payload(*parse_esp_line(line))
            response = post_to_dashboard(payload)
            
            current_anomaly_state = dashboard_alarm_state(response, alarm_active)
            learned_online = False
            if response.status_code == 200 and not current_anomaly_state:
                learned_online = learn_from_nominal_payload(payload)

            if current_anomaly_state and not alarm_active:
                print(f"[!!!] CONFIRMED ANOMALY ALERT FOR NODE {payload['node_id']}! Writing to serial...")
                command = {"alarm": True}
                ser.write((json.dumps(command) + "\n").encode("utf-8"))
                ser.flush() # Forces serial pipe clear execution immediately
                alarm_active = True

            elif not current_anomaly_state and alarm_active:
                print(f"[+] Node {payload['node_id']} returned to normal. Turning off hardware alarm.")
                command = {"alarm": False}
                ser.write((json.dumps(command) + "\n").encode("utf-8"))
                ser.flush()
                alarm_active = False

            # Console Reporting Block
            status = "ANOMALY" if current_anomaly_state else "Healthy"
            api_status = ""
            if response.status_code != 200:
                api_status = f" | API returned HTTP {response.status_code}: {response.text[:120]}"
            
            print(
                f"{payload['node_id']} | {status} | "
                f"vib={payload['vibr_x']:.3f}, temp={payload['m_temp']:.1f}, "
                f"press={payload['press']:.2f}, dist={payload['cluster_distance']:.2f}"
                f"{' | model updated' if learned_online else ''}"
                f"{api_status}"
            )

        except ValueError as exc:
            print(f"Skipping malformed serial line {line!r}: {exc}")
            continue
        except requests.RequestException as exc:
            print(f"Dashboard update failed for {FLASK_UPDATE_URL}: {exc}")
            time.sleep(1)
            continue
        except serial.SerialException as exc:
            print(f"Serial communications error: {exc}")
            time.sleep(1)
            continue


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n[*] Shutting down telemetry processor script safely.")
