import hashlib
import hmac
import os
import zlib
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from supabase_storage import insert_security_incident


DEVICE_TOKEN = os.getenv("DEVICE_TOKEN", "development-device-token")
TELEMETRY_SECRET = os.getenv("TELEMETRY_SECRET", "development-telemetry-secret")
LOGIN_WINDOW_SECONDS = int(os.getenv("IDS_LOGIN_WINDOW_SECONDS", "300"))
MAX_FAILED_LOGINS = int(os.getenv("IDS_MAX_FAILED_LOGINS", "3"))
MAX_PACKET_FAILURES = int(os.getenv("IDS_MAX_PACKET_FAILURES", "3"))

_failed_logins = defaultdict(deque)
_packet_failures = defaultdict(deque)


def utc_now():
    return datetime.now(timezone.utc)


def iso_now():
    return utc_now().isoformat()


def _prune(events, window_seconds):
    cutoff = utc_now() - timedelta(seconds=window_seconds)
    while events and events[0] < cutoff:
        events.popleft()


def _remember(counter, key, window_seconds):
    events = counter[key]
    events.append(utc_now())
    _prune(events, window_seconds)
    return len(events)


def create_incident(db, event_type, severity, source, details):
    created_at = iso_now()
    buzzer_triggered = severity in {"high", "critical"}
    led_triggered = severity in {"medium", "high", "critical"}
    db.execute(
        """
        INSERT INTO security_incidents
            (event_type, severity, source, details, buzzer_triggered, led_triggered, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event_type,
            severity,
            source,
            details,
            int(buzzer_triggered),
            int(led_triggered),
            created_at,
        ),
    )
    try:
        insert_security_incident({
            "event_type": event_type,
            "severity": severity,
            "source": source,
            "details": details,
            "buzzer_triggered": buzzer_triggered,
            "led_triggered": led_triggered,
            "created_at": created_at,
        })
    except Exception as exc:
        print(f"Supabase security incident sync failed: {exc}")


def record_failed_login(db, operator_id, source):
    key = f"{source}:{operator_id or 'unknown'}"
    failures = _remember(_failed_logins, key, LOGIN_WINDOW_SECONDS)

    create_incident(
        db,
        "FAILED_LOGIN",
        "medium" if failures < MAX_FAILED_LOGINS else "high",
        source,
        f"Failed login for operator '{operator_id or 'unknown'}'. Count in window: {failures}.",
    )

    if failures >= MAX_FAILED_LOGINS:
        create_incident(
            db,
            "REPEATED_FAILED_ACCESS",
            "high",
            source,
            f"Repeated failed login threshold reached for operator '{operator_id or 'unknown'}'.",
        )


def record_packet_failure(db, source, reason):
    failures = _remember(_packet_failures, source, LOGIN_WINDOW_SECONDS)
    create_incident(
        db,
        "NETWORK_ANOMALY",
        "medium" if failures < MAX_PACKET_FAILURES else "high",
        source,
        f"{reason}. Packet failure count in window: {failures}.",
    )


def validate_device_token(db, request_headers, source):
    token = request_headers.get("X-Device-Token", "")
    if hmac.compare_digest(token, DEVICE_TOKEN):
        return True

    create_incident(
        db,
        "UNAUTHORIZED_DEVICE",
        "critical",
        source,
        "Telemetry update rejected because the device token was missing or invalid.",
    )
    return False


def canonical_telemetry_string(payload):
    values = [
        str(payload["node_id"]),
        f"{float(payload['vibr_x']):.6f}",
        f"{float(payload['m_temp']):.6f}",
        f"{float(payload['press']):.6f}",
        str(int(payload.get("cluster", 0))),
        f"{float(payload.get('cluster_distance', 0.0)):.6f}",
        "1" if bool(payload["anomaly"]) else "0",
    ]
    return "|".join(values)


def compute_crc32(data):
    return format(zlib.crc32(data.encode("utf-8")) & 0xFFFFFFFF, "08x")


def compute_hmac(data):
    return hmac.new(
        TELEMETRY_SECRET.encode("utf-8"),
        data.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def validate_integrity(db, payload, source):
    checksum = str(payload.get("checksum", "")).lower()
    signature = str(payload.get("signature", "")).lower()

    if not checksum and not signature:
        record_packet_failure(db, source, "Telemetry rejected because no checksum or signature was supplied")
        return False, "Telemetry integrity value required"

    try:
        canonical = canonical_telemetry_string(payload)
    except (KeyError, TypeError, ValueError) as exc:
        record_packet_failure(db, source, f"Telemetry rejected during integrity parsing: {exc}")
        return False, "Telemetry could not be canonicalized for integrity validation"

    expected_crc = compute_crc32(canonical)
    expected_hmac = compute_hmac(canonical)
    crc_ok = checksum and hmac.compare_digest(checksum, expected_crc)
    hmac_ok = signature and hmac.compare_digest(signature, expected_hmac)

    if crc_ok or hmac_ok:
        return True, "Integrity validation passed"

    record_packet_failure(
        db,
        source,
        "Telemetry rejected because checksum/signature verification failed",
    )
    return False, "Telemetry integrity validation failed"


def security_summary(db, limit=8):
    incidents = db.execute(
        """
        SELECT event_type, severity, source, details, buzzer_triggered, led_triggered, created_at
        FROM security_incidents
        ORDER BY id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()

    latest = [dict(row) for row in incidents]
    active = any(row["severity"] in {"high", "critical"} for row in latest[:3])
    return {
        "ids_status": "ALERT" if active else "CLEAR",
        "buzzer": active,
        "warning_led": active or any(row["severity"] == "medium" for row in latest[:3]),
        "recent_incidents": latest,
    }
