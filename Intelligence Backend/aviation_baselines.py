from dataclasses import dataclass


SEA_LEVEL_PRESSURE_MB = 1013.25
ISA_SEA_LEVEL_TEMP_C = 15.0
ISA_TEMP_LAPSE_C_PER_1000FT = 2.0
PRESSURE_SCALE_HEIGHT_FT = 27500.0

VIBRATION_NORMAL_G = (0.5, 1.5)
VIBRATION_CRITICAL_G = 5.0
VIBRATION_SPIKE_FACTOR = 2.0

INTERNAL_TEMP_CRITICAL_C = 55.0
EXTERNAL_TEMP_CRITICAL_C = 85.0
CABIN_STRUCTURAL_MIN_PRESSURE_MB = 750.0
PRESSURE_TOLERANCE_MB = 150.0


@dataclass(frozen=True)
class BaselineAlert:
    sensor: str
    severity: str
    message: str
    observed: float
    limit: float

    def as_dict(self):
        return {
            "sensor": self.sensor,
            "severity": self.severity,
            "message": self.message,
            "observed": round(self.observed, 3),
            "limit": round(self.limit, 3),
        }


def isa_temperature_c(altitude_ft):
    return ISA_SEA_LEVEL_TEMP_C - (max(0.0, altitude_ft) / 1000.0 * ISA_TEMP_LAPSE_C_PER_1000FT)


def isa_pressure_mb(altitude_ft):
    return SEA_LEVEL_PRESSURE_MB * pow(2.718281828, -max(0.0, altitude_ft) / PRESSURE_SCALE_HEIGHT_FT)


def baseline_summary(altitude_ft=0.0, temp_location="internal"):
    temp_limit = EXTERNAL_TEMP_CRITICAL_C if temp_location == "external" else INTERNAL_TEMP_CRITICAL_C
    return {
        "standard": "ISA / RTCA DO-160 physical anchors",
        "altitude_ft": round(float(altitude_ft), 1),
        "temperature_location": temp_location,
        "vibration_normal_g": list(VIBRATION_NORMAL_G),
        "vibration_critical_g": VIBRATION_CRITICAL_G,
        "pressure_isa_mb": round(isa_pressure_mb(float(altitude_ft)), 2),
        "pressure_minimum_mb": CABIN_STRUCTURAL_MIN_PRESSURE_MB,
        "temperature_isa_c": round(isa_temperature_c(float(altitude_ft)), 2),
        "temperature_critical_c": temp_limit,
    }


def evaluate_physical_baselines(reading, previous=None):
    altitude_ft = float(reading.get("altitude_ft", 0.0) or 0.0)
    temp_location = str(reading.get("temp_location", "internal") or "internal").strip().lower()
    if temp_location not in {"internal", "external"}:
        temp_location = "internal"

    vibration = float(reading["vibr_x"])
    temperature = float(reading["m_temp"])
    pressure = float(reading["press"])
    expected_pressure = isa_pressure_mb(altitude_ft)
    temp_limit = EXTERNAL_TEMP_CRITICAL_C if temp_location == "external" else INTERNAL_TEMP_CRITICAL_C

    alerts = []
    if vibration > VIBRATION_CRITICAL_G:
        alerts.append(BaselineAlert(
            "Vibration",
            "critical",
            "Vibration crossed the DO-160 hard boundary.",
            vibration,
            VIBRATION_CRITICAL_G,
        ))

    if previous and float(previous.get("vibr_x", 0.0)) > 0:
        previous_vibration = float(previous["vibr_x"])
        if vibration >= previous_vibration * VIBRATION_SPIKE_FACTOR and vibration > VIBRATION_NORMAL_G[1]:
            alerts.append(BaselineAlert(
                "Vibration",
                "critical",
                "Vibration produced a sudden 2x spike above the previous accepted packet.",
                vibration,
                previous_vibration * VIBRATION_SPIKE_FACTOR,
            ))

    if pressure < CABIN_STRUCTURAL_MIN_PRESSURE_MB:
        alerts.append(BaselineAlert(
            "Pressure",
            "critical",
            "Pressure dropped below the cabin structural minimum.",
            pressure,
            CABIN_STRUCTURAL_MIN_PRESSURE_MB,
        ))
    elif abs(pressure - expected_pressure) > PRESSURE_TOLERANCE_MB:
        alerts.append(BaselineAlert(
            "Pressure",
            "caution",
            "Pressure has moved outside the ISA altitude reference band.",
            pressure,
            expected_pressure,
        ))

    if temperature > temp_limit:
        alerts.append(BaselineAlert(
            "Temperature",
            "critical",
            "Temperature crossed the DO-160 thermal boundary.",
            temperature,
            temp_limit,
        ))

    summary = baseline_summary(altitude_ft, temp_location)
    summary["status"] = "critical" if any(alert.severity == "critical" for alert in alerts) else "nominal"
    summary["alerts"] = [alert.as_dict() for alert in alerts]
    return summary
