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


def insert_telemetry(payload):
    if not is_enabled():
        return False

    row = {
        "node_id": payload.get("node_id"),
        "vibr_x": payload.get("vibr_x"),
        "m_temp": payload.get("m_temp"),
        "press": payload.get("press"),
        "cluster": payload.get("cluster"),
        "cluster_distance": payload.get("cluster_distance"),
        "ai_confidence": payload.get("ai_confidence"),
        "composite_trend_value": payload.get("composite_trend_value"),
        "anomaly": payload.get("anomaly"),
        "telemetry_quality": payload.get("telemetry_quality"),
        "integrity": payload.get("integrity"),
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
