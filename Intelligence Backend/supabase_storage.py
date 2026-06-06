import os

import requests


SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_TIMEOUT_SECONDS = float(os.getenv("SUPABASE_TIMEOUT_SECONDS", "5"))


def is_enabled():
    return bool(SUPABASE_URL and SUPABASE_KEY)


def _headers(prefer=None):
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def _table_url(table_name):
    return f"{SUPABASE_URL}/rest/v1/{table_name}"


def _post(table_name, row, prefer="return=minimal", params=None):
    if not is_enabled():
        return False

    response = requests.post(
        _table_url(table_name),
        params=params,
        json=row,
        headers=_headers(prefer),
        timeout=SUPABASE_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return True


def upsert_organisation(name):
    return _post(
        "organisations",
        {"name": name},
        prefer="resolution=merge-duplicates,return=minimal",
        params={"on_conflict": "name"},
    )


def upsert_operator(operator):
    upsert_organisation(operator["organisation"])
    row = {
        "operator_id": operator["operator_id"],
        "full_name": operator["full_name"],
        "organisation": operator["organisation"],
        "password_hash": operator["password_hash"],
        "role": operator.get("role", "operator"),
        "status": operator.get("status", "active"),
        "created_at": operator.get("created_at"),
        "updated_at": operator.get("updated_at") or operator.get("created_at"),
    }
    return _post(
        "operators",
        row,
        prefer="resolution=merge-duplicates,return=minimal",
        params={"on_conflict": "operator_id"},
    )


def insert_session(token, operator_id, expires_at, created_at):
    return _post(
        "sessions",
        {
            "token": token,
            "operator_id": operator_id,
            "expires_at": expires_at,
            "created_at": created_at,
        },
    )


def insert_security_incident(incident):
    row = {
        "event_type": incident["event_type"],
        "severity": incident["severity"],
        "source": incident["source"],
        "details": incident["details"],
        "buzzer_triggered": bool(incident.get("buzzer_triggered")),
        "led_triggered": bool(incident.get("led_triggered")),
        "created_at": incident["created_at"],
    }
    return _post("security_incidents", row)


def insert_telemetry(payload):
    if not is_enabled():
        return False

    row = {
        "node_id": payload.get("node_id"),
        "vibr_x": payload.get("vibr_x"),
        "m_temp": payload.get("m_temp"),
        "press": payload.get("press"),
        "altitude_ft": payload.get("altitude_ft"),
        "temp_location": payload.get("temp_location"),
        "cluster": payload.get("cluster"),
        "cluster_distance": payload.get("cluster_distance"),
        "ai_confidence": payload.get("ai_confidence"),
        "composite_trend_value": payload.get("composite_trend_value"),
        "anomaly": payload.get("anomaly"),
        "telemetry_quality": payload.get("telemetry_quality"),
        "integrity": payload.get("integrity"),
        "baseline_status": payload.get("baseline_status"),
        "baseline": payload.get("baseline"),
        "received_at": payload.get("received_at"),
    }
    response = requests.post(
        _table_url("flight_telemetry"),
        json=row,
        headers=_headers("return=minimal"),
        timeout=SUPABASE_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return True


def latest_telemetry():
    if not is_enabled():
        return None

    response = requests.get(
        _table_url("flight_telemetry"),
        params={"select": "*", "order": "received_at.desc", "limit": "1"},
        headers=_headers(),
        timeout=SUPABASE_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    rows = response.json()
    if not rows:
        return None

    row = rows[0]
    row.pop("id", None)
    return row
