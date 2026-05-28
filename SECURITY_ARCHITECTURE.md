# Security Architecture

## Intrusion Detection Layer

The backend implements an embedded-style Intrusion Detection System that monitors operator access and telemetry ingestion. Security incidents are stored in the `security_incidents` database table and exposed to the dashboard through `/data` and `/security/incidents`.

The IDS monitors:

- Unusual login attempts through repeated authentication failures.
- Unauthorized device connections through the `X-Device-Token` telemetry header.
- Repeated failed access within a configurable time window.
- Network and packet anomalies such as malformed, unsigned, or checksum-failed telemetry.

When a high or critical incident is detected, the backend marks the security output as active:

- `buzzer: true`
- `warning_led: true`
- `ids_status: "ALERT"`

This allows the dashboard or hardware layer to trigger a buzzer, flash a warning LED, and log the incident.

## Data Integrity Verification

Telemetry integrity validation mechanisms were implemented to prevent corrupted telemetry data from influencing system decisions.

The system uses two layers:

- CRC32 checksum validation for packet corruption detection.
- HMAC-SHA256 signature validation for stronger tamper detection when `TELEMETRY_SECRET` is configured.

The ESP32 reference sketch emits:

```text
vibration,temperature,pressure,crc32
```

The Python telemetry bridge validates the optional ESP32 CRC, calculates the KMeans result, then sends backend telemetry with:

- `checksum`
- `signature`
- `X-Device-Token`

The Flask backend rejects telemetry if the device token or integrity values are missing or invalid.

## Secure Boot Concept

The ESP32 sketch includes a simulated secure boot check before telemetry begins. If the measured firmware hash does not match the approved firmware hash, startup is rejected and the warning outputs are triggered.

For a production ESP32 deployment, this concept maps to:

- ESP32 Secure Boot V2
- Flash Encryption
- Signed firmware images
- Rejection of modified firmware before application startup

Report wording:

> Secure boot and firmware integrity verification concepts were introduced to ensure that only approved firmware can execute on the telemetry node. This prevents modified firmware from injecting false flight data or bypassing safety checks.

## Runtime Configuration

Recommended environment variables:

```powershell
$env:DEVICE_TOKEN = "replace-with-a-long-random-device-token"
$env:TELEMETRY_SECRET = "replace-with-a-long-random-telemetry-secret"
$env:IDS_MAX_FAILED_LOGINS = "3"
$env:IDS_MAX_PACKET_FAILURES = "3"
```

Use the same `DEVICE_TOKEN` for the Python telemetry bridge and Flask backend.
