import secrets
import sqlite3
import math
import os
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

import requests
from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.security import check_password_hash, generate_password_hash

from aviation_baselines import baseline_summary, evaluate_physical_baselines
from security_layer import (
    record_failed_login,
    security_summary,
    validate_device_token,
    validate_integrity,
)
from supabase_storage import (
    insert_session,
    insert_telemetry,
    is_enabled as supabase_enabled,
    latest_telemetry,
    upsert_operator,
)

app = Flask(__name__)
CORS(app) # Allows React to talk to Flask

BASE_DIR = Path(__file__).resolve().parent
DATABASE_PATH = BASE_DIR / "flight_ops.db"
SESSION_HOURS = 12
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
DEFAULT_ORGANISATION = os.getenv("DEFAULT_ORGANISATION", "Aero-Mesh Operations")
TELEMETRY_LIMITS = {
    "vibr_x": (0.0, 20.0),
    "m_temp": (-40.0, 125.0),
    "press": (300.0, 1100.0),
    "altitude_ft": (0.0, 45000.0),
    "cluster_distance": (0.0, 1000.0),
    "ai_confidence": (0.0, 100.0),
}
MAX_SINGLE_PACKET_JUMP = {
    "vibr_x": 3.0,
    "m_temp": 25.0,
    "press": 120.0,
    "cluster_distance": 80.0,
}
ANOMALY_CONFIRMATION_PACKETS = 2


def get_db():
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db():
    with get_db() as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS operators (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                operator_id TEXT NOT NULL UNIQUE,
                full_name TEXT NOT NULL,
                organisation TEXT NOT NULL DEFAULT 'Aero-Mesh Operations',
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        columns = db.execute("PRAGMA table_info(operators)").fetchall()
        column_names = {column["name"] for column in columns}
        if "organisation" not in column_names:
            db.execute(
                """
                ALTER TABLE operators
                ADD COLUMN organisation TEXT NOT NULL DEFAULT 'Aero-Mesh Operations'
                """
            )
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                operator_id TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (operator_id) REFERENCES operators (operator_id)
            )
            """
        )
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS security_incidents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                severity TEXT NOT NULL,
                source TEXT NOT NULL,
                details TEXT NOT NULL,
                buzzer_triggered INTEGER NOT NULL DEFAULT 0,
                led_triggered INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
            """
        )


def operator_from_token(token):
    if not token:
        return None

    now = datetime.now(timezone.utc).isoformat()
    with get_db() as db:
        session = db.execute(
            """
            SELECT operators.operator_id, operators.full_name, operators.organisation
            FROM sessions
            JOIN operators ON operators.operator_id = sessions.operator_id
            WHERE sessions.token = ? AND sessions.expires_at > ?
            """,
            (token, now),
        ).fetchone()

    return dict(session) if session else None


def require_auth(route_handler):
    @wraps(route_handler)
    def wrapped(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        token = auth_header.replace("Bearer ", "", 1).strip()
        operator = operator_from_token(token)
        if not operator:
            return jsonify({"status": "error", "message": "Authentication required"}), 401

        request.operator = operator
        return route_handler(*args, **kwargs)

    return wrapped


def create_session(operator_id):
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(hours=SESSION_HOURS)
    created_at = now.isoformat()
    expires_at_iso = expires_at.isoformat()

    with get_db() as db:
        db.execute(
            """
            INSERT INTO sessions (token, operator_id, expires_at, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (token, operator_id, expires_at_iso, created_at),
        )

    try:
        insert_session(token, operator_id, expires_at_iso, created_at)
    except Exception as exc:
        print(f"Supabase session sync failed: {exc}")

    return token, expires_at_iso


def normalize_operator_id(operator_id):
    return str(operator_id or "").strip().lower()


latest_flight_data = {
    "node_id": "None",
    "vibr_x": 0.0,
    "m_temp": 0.0,
    "press": 0,
    "altitude_ft": 0.0,
    "temp_location": "internal",
    "cluster": 0,
    "cluster_distance": 0.0,
    "ai_confidence": 0.0,
    "composite_trend_value": 0.0,
    "anomaly": False,
    "telemetry_quality": "waiting",
    "baseline": baseline_summary(),
}
telemetry_window = []
anomaly_streak = 0


def utc_iso():
    return datetime.now(timezone.utc).isoformat()


def parse_float_field(payload, field):
    value = float(payload[field])
    if not math.isfinite(value):
        raise ValueError(f"{field} is not finite")
    return value


def parse_bool_field(payload, field):
    value = payload[field]
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "y", "anomaly"}:
            return True
        if normalized in {"false", "0", "no", "n", "normal"}:
            return False
    raise ValueError(f"{field} must be a boolean value")


def validate_and_filter_telemetry(payload):
    global anomaly_streak

    candidate = {
        "node_id": str(payload["node_id"]),
        "vibr_x": parse_float_field(payload, "vibr_x"),
        "m_temp": parse_float_field(payload, "m_temp"),
        "press": parse_float_field(payload, "press"),
        "altitude_ft": parse_float_field(payload, "altitude_ft") if "altitude_ft" in payload else 0.0,
        "temp_location": str(payload.get("temp_location", "internal")).strip().lower() or "internal",
        "cluster": int(payload.get("cluster", 0)),
        "cluster_distance": parse_float_field(payload, "cluster_distance") if "cluster_distance" in payload else 0.0,
        "ai_confidence": parse_float_field(payload, "ai_confidence") if "ai_confidence" in payload else 0.0,
        "raw_anomaly": parse_bool_field(payload, "anomaly"),
    }

    if candidate["temp_location"] not in {"internal", "external"}:
        candidate["temp_location"] = "internal"

    for field, (minimum, maximum) in TELEMETRY_LIMITS.items():
        if not minimum <= candidate[field] <= maximum:
            return None, f"{field} value {candidate[field]:.3f} is outside the valid sensor range"

    if latest_flight_data.get("integrity") == "verified":
        for field, maximum_jump in MAX_SINGLE_PACKET_JUMP.items():
            if abs(candidate[field] - float(latest_flight_data.get(field, 0.0))) > maximum_jump:
                return None, f"{field} jumped too far in a single packet and was treated as transmission noise"

    baseline = evaluate_physical_baselines(candidate, latest_flight_data)
    hard_boundary = baseline["status"] == "critical"

    recent = telemetry_window[-4:] + [candidate]
    filtered = dict(candidate)
    for field in ("vibr_x", "m_temp", "press", "cluster_distance", "ai_confidence"):
        filtered[field] = sum(item[field] for item in recent) / len(recent)

    anomaly_streak = anomaly_streak + 1 if candidate["raw_anomaly"] else 0
    filtered["anomaly"] = hard_boundary or anomaly_streak >= ANOMALY_CONFIRMATION_PACKETS
    filtered["baseline"] = baseline
    filtered["baseline_status"] = baseline["status"]
    filtered["telemetry_quality"] = "critical" if hard_boundary else "filtered" if len(recent) > 1 else "verified"
    filtered["integrity"] = "verified"
    filtered["received_at"] = utc_iso()

    norm_vibration = filtered["vibr_x"] * 2.0
    norm_temperature = max(0.0, (filtered["m_temp"] - 25.0) * 0.1)
    norm_distance = filtered["cluster_distance"] * 0.5
    norm_confidence = max(0.0, (100.0 - filtered["ai_confidence"]) * 0.03)
    filtered["composite_trend_value"] = round(norm_vibration + norm_temperature + norm_distance + norm_confidence, 2)

    return filtered, "Telemetry accepted after validation and noise filtering"


def upsert_google_operator(profile, organisation):
    email = profile["email"].strip().lower()
    full_name = profile.get("name") or email.split("@")[0]
    now = utc_iso()
    password_hash = generate_password_hash(secrets.token_urlsafe(32))

    with get_db() as db:
        operator = db.execute(
            "SELECT operator_id, full_name, organisation, password_hash, created_at FROM operators WHERE operator_id = ?",
            (email,),
        ).fetchone()

        if not operator:
            db.execute(
                """
                INSERT INTO operators (operator_id, full_name, organisation, password_hash, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (email, full_name, organisation, password_hash, now),
            )
            operator = {
                "operator_id": email,
                "full_name": full_name,
                "organisation": organisation,
                "password_hash": password_hash,
                "created_at": now,
            }

    operator = dict(operator)
    try:
        upsert_operator(operator)
    except Exception as exc:
        print(f"Supabase operator sync failed: {exc}")

    operator.pop("password_hash", None)
    return operator


@app.route('/auth/signup', methods=['POST'])
def signup():
    payload = request.get_json(silent=True) or {}
    operator_id = normalize_operator_id(payload.get("operator_id"))
    full_name = str(payload.get("full_name", "")).strip()
    organisation = str(payload.get("organisation", DEFAULT_ORGANISATION)).strip() or DEFAULT_ORGANISATION
    password = str(payload.get("password", ""))

    if not operator_id or not full_name or not password:
        return jsonify({"status": "error", "message": "Operator ID, full name, and password are required"}), 400

    if len(password) < 6:
        return jsonify({"status": "error", "message": "Password must be at least 6 characters"}), 400

    password_hash = generate_password_hash(password)
    created_at = datetime.now(timezone.utc).isoformat()

    try:
        with get_db() as db:
            db.execute(
                """
                INSERT INTO operators (operator_id, full_name, organisation, password_hash, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    operator_id,
                    full_name,
                    organisation,
                    password_hash,
                    created_at,
                ),
            )
    except sqlite3.IntegrityError:
        return jsonify({"status": "error", "message": "Operator ID already exists"}), 409

    try:
        upsert_operator({
            "operator_id": operator_id,
            "full_name": full_name,
            "organisation": organisation,
            "password_hash": password_hash,
            "created_at": created_at,
        })
    except Exception as exc:
        print(f"Supabase operator sync failed: {exc}")

    token, expires_at = create_session(operator_id)
    return jsonify({
        "status": "success",
        "token": token,
        "expires_at": expires_at,
        "operator": {"operator_id": operator_id, "full_name": full_name, "organisation": organisation},
    }), 201


@app.route('/auth/login', methods=['POST'])
def login():
    payload = request.get_json(silent=True) or {}
    operator_id = normalize_operator_id(payload.get("operator_id"))
    password = str(payload.get("password", ""))
    source = request.headers.get("X-Forwarded-For", request.remote_addr or "unknown")

    with get_db() as db:
        operator = db.execute(
            "SELECT operator_id, full_name, organisation, password_hash, created_at FROM operators WHERE operator_id = ?",
            (operator_id,),
        ).fetchone()

    if not operator or not check_password_hash(operator["password_hash"], password):
        with get_db() as db:
            record_failed_login(db, operator_id, source)
        return jsonify({"status": "error", "message": "Invalid operator ID or password"}), 401

    try:
        upsert_operator(dict(operator))
    except Exception as exc:
        print(f"Supabase operator sync failed: {exc}")

    token, expires_at = create_session(operator_id)
    return jsonify({
        "status": "success",
        "token": token,
        "expires_at": expires_at,
        "operator": {
            "operator_id": operator["operator_id"],
            "full_name": operator["full_name"],
            "organisation": operator["organisation"],
        },
    })


@app.route('/auth/google', methods=['POST'])
def google_auth():
    if not GOOGLE_CLIENT_ID:
        return jsonify({
            "status": "error",
            "message": "Google sign-up is not configured. Set GOOGLE_CLIENT_ID on the backend.",
        }), 503

    payload = request.get_json(silent=True) or {}
    credential = str(payload.get("credential", "")).strip()
    organisation = str(payload.get("organisation", DEFAULT_ORGANISATION)).strip() or DEFAULT_ORGANISATION
    if not credential:
        return jsonify({"status": "error", "message": "Google credential is required"}), 400

    try:
        response = requests.get(
            "https://oauth2.googleapis.com/tokeninfo",
            params={"id_token": credential},
            timeout=8,
        )
        response.raise_for_status()
        profile = response.json()
    except requests.RequestException:
        return jsonify({"status": "error", "message": "Unable to verify Google sign-up"}), 401

    if profile.get("aud") != GOOGLE_CLIENT_ID or profile.get("email_verified") not in {"true", True}:
        return jsonify({"status": "error", "message": "Google account could not be verified"}), 401

    operator = upsert_google_operator(profile, organisation)
    token, expires_at = create_session(operator["operator_id"])
    return jsonify({
        "status": "success",
        "token": token,
        "expires_at": expires_at,
        "operator": operator,
    })


@app.route('/auth/me', methods=['GET'])
@require_auth
def current_operator():
    return jsonify({"status": "success", "operator": request.operator})


@app.route('/operators', methods=['GET'])
@require_auth
def get_operators():
    with get_db() as db:
        operators = db.execute(
            """
            SELECT operator_id, full_name, organisation, created_at
            FROM operators
            WHERE organisation = ?
            ORDER BY full_name COLLATE NOCASE ASC
            """,
            (request.operator["organisation"],),
        ).fetchall()

    return jsonify({
        "status": "success",
        "organisation": request.operator["organisation"],
        "operators": [dict(operator) for operator in operators],
    })


@app.route('/update', methods=['POST'])
def update():
    global latest_flight_data
    payload = request.get_json(silent=True)
    if not payload:
        return jsonify({"status": "error", "message": "JSON payload required"}), 400
    source = request.headers.get("X-Forwarded-For", request.remote_addr or "unknown")

    required_fields = ("node_id", "vibr_x", "m_temp", "press", "anomaly")
    missing_fields = [field for field in required_fields if field not in payload]
    if missing_fields:
        return jsonify({
            "status": "error",
            "message": f"Missing field(s): {', '.join(missing_fields)}"
        }), 400

    with get_db() as db:
        if not validate_device_token(db, request.headers, source):
            return jsonify({
                "status": "error",
                "message": "Unauthorized telemetry device",
                "security": security_summary(db),
            }), 403

        integrity_ok, integrity_message = validate_integrity(db, payload, source)
        if not integrity_ok:
            return jsonify({
                "status": "error",
                "message": integrity_message,
                "security": security_summary(db),
            }), 400

    try:
        filtered_data, quality_message = validate_and_filter_telemetry(payload)
    except (TypeError, ValueError) as exc:
        return jsonify({
            "status": "ignored",
            "message": f"Telemetry packet ignored as sensor noise: {exc}",
            "telemetry_quality": "ignored",
        }), 202

    if filtered_data is None:
        return jsonify({
            "status": "ignored",
            "message": quality_message,
            "telemetry_quality": "ignored",
        }), 202

    telemetry_window.append(filtered_data)
    if len(telemetry_window) > 5:
        telemetry_window.pop(0)

    latest_flight_data = filtered_data
    supabase_saved = False
    try:
        supabase_saved = insert_telemetry(filtered_data)
    except requests.RequestException as exc:
        print(f"Supabase telemetry save failed: {exc}")

    print(f"Data Received: {latest_flight_data}")
    return jsonify({
        "status": "success",
        "message": quality_message,
        "anomaly": filtered_data["anomaly"],
        "alarm": filtered_data["anomaly"],
        "telemetry_quality": filtered_data["telemetry_quality"],
        "baseline_status": filtered_data["baseline_status"],
        "baseline": filtered_data["baseline"],
        "ai_confidence": filtered_data["ai_confidence"],
        "composite_trend_value": filtered_data["composite_trend_value"],
        "supabase_saved": supabase_saved,
    }), 200


@app.route('/data', methods=['GET'])
@require_auth
def get_data():
    with get_db() as db:
        payload = None
        try:
            payload = latest_telemetry()
        except requests.RequestException as exc:
            print(f"Supabase telemetry fetch failed: {exc}")

        if not payload:
            payload = dict(latest_flight_data)

        payload["security"] = security_summary(db)
        payload["supabase_enabled"] = supabase_enabled()
    return jsonify(payload)


@app.route('/security/incidents', methods=['GET'])
@require_auth
def get_security_incidents():
    with get_db() as db:
        return jsonify({"status": "success", "security": security_summary(db, limit=20)})


@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "service": "aerogauge-api"})


init_db()

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
