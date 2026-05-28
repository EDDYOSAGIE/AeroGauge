import os
import sys
import time
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

# The ESP relay prints either:
#   vibration,temp,pressure[,crc32]
#   node_id,vibration,temp,pressure
FEATURE_NAMES = ("vibration", "temperature", "pressure")


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


def parse_esp_line(line):
    """Convert Arduino Serial telemetry into a node id and feature floats."""
    parts = [value.strip() for value in line.split(",")]
    if len(parts) not in (len(FEATURE_NAMES), len(FEATURE_NAMES) + 1):
        raise ValueError(f"expected 3 or 4 comma-separated values, got {len(parts)}")

    if len(parts) == len(FEATURE_NAMES) + 1 and _is_float(parts[-1]):
        node_id = parts[0]
        vibration, temperature, pressure = [float(value) for value in parts[1:]]
        return node_id, vibration, temperature, pressure

    if len(parts) == len(FEATURE_NAMES) + 1:
        sensor_payload = ",".join(parts[: len(FEATURE_NAMES)])
        expected_crc = compute_crc32(sensor_payload)
        received_crc = parts[-1].lower().replace("0x", "")
        if received_crc != expected_crc:
            raise ValueError(
                f"serial CRC mismatch: expected {expected_crc}, received {received_crc}"
            )

    vibration, temperature, pressure = [float(value) for value in parts[: len(FEATURE_NAMES)]]
    return NODE_ID, vibration, temperature, pressure


def anomaly_distance(vibration, temperature, pressure):
    point = np.array([[vibration, temperature, pressure]], dtype=float)
    return float(kmeans_model.distances(point)[0])


def build_payload(node_id, vibration, temperature, pressure):
    prediction = kmeans_model.predict([[vibration, temperature, pressure]])
    payload = {
        "node_id": node_id,
        "vibr_x": vibration,
        "m_temp": temperature,
        "press": pressure,
        "cluster": prediction["cluster"],
        "cluster_distance": prediction["cluster_distance"],
        "anomaly": prediction["anomaly"],
    }
    canonical = canonical_telemetry_string(payload)
    payload["checksum"] = compute_crc32(canonical)
    payload["signature"] = compute_hmac(canonical)
    return payload


def post_to_dashboard(payload):
    headers = {"X-Device-Token": DEVICE_TOKEN}
    response = requests.post(FLASK_UPDATE_URL, json=payload, headers=headers, timeout=2)
    response.raise_for_status()


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
        time.sleep(2)
    except serial.SerialException as exc:
        print(f"Could not open serial port {serial_port}: {exc}", file=sys.stderr)
        return 1

    print(f"Monitoring ESP relay on {serial_port} at {BAUD_RATE} baud...")
    print("Expected serial format: node_id,vibration,temp,pressure")

    while True:
        line = ser.readline().decode("utf-8", errors="replace").strip()
        if not line:
            continue

        try:
            payload = build_payload(*parse_esp_line(line))
            post_to_dashboard(payload)
        except ValueError as exc:
            print(f"Skipping malformed serial line {line!r}: {exc}")
            continue
        except requests.RequestException as exc:
            print(f"Dashboard update failed: {exc}")
            time.sleep(1)
            continue

        status = "ANOMALY" if payload["anomaly"] else "Healthy"
        print(
            f"{payload['node_id']} | {status} | "
            f"vib={payload['vibr_x']:.3f}, temp={payload['m_temp']:.1f}, "
            f"press={payload['press']:.2f}, dist={payload['cluster_distance']:.2f}"
        )


if __name__ == "__main__":
    raise SystemExit(main())
