"""
train_kmeans_model.py
─────────────────────
Train, evaluate, and save the flight KMeans anomaly model.

Threshold strategy
──────────────────
Instead of using a purely statistical percentile of training distances, the
threshold is now *anchored to the ISA / DO-160 physical limits* defined in
aviation_baselines.py.

How it works:
  1. We project each DO-160 boundary (vibration, temperature, pressure) into
     the same 3-D feature space the model uses: [vibration, temperature,
     pressure].
  2. We measure the KMeans distance from each boundary point to its nearest
     cluster centroid.
  3. We take the *minimum* of those boundary distances as the physics-derived
     threshold ceiling, then scale it by a safety margin (default 0.85) so
     the model fires slightly before the hard limit.
  4. The final threshold is the *lower* of:
       • the physics-derived ceiling, and
       • the statistical percentile of training distances (default 95th),
     ensuring the model cannot be looser than either constraint allows.

This means the cluster "normal" envelope is realistically bounded by aviation
standards rather than by whatever the training sample happened to contain.
"""

import argparse
import json

from aviation_baselines import (
    VIBRATION_CRITICAL_G,
    VIBRATION_NORMAL_G,
    INTERNAL_TEMP_CRITICAL_C,
    EXTERNAL_TEMP_CRITICAL_C,
    CABIN_STRUCTURAL_MIN_PRESSURE_MB,
    SEA_LEVEL_PRESSURE_MB,
    isa_pressure_mb,
    isa_temperature_c,
)
from kmeans_model import (
    DEFAULT_METRICS_PATH,
    DEFAULT_MODEL_PATH,
    FlightKMeansModel,
    load_training_data,
    save_metrics,
    train_kmeans_model,
)

# Safety margin: the physics threshold is multiplied by this before being used
# as a ceiling.  0.85 means the model fires when the reading is 85 % of the
# way to the DO-160 hard limit, giving operators an early-warning window.
PHYSICS_SAFETY_MARGIN = 0.85


def boundary_points(altitude_ft: float = 0.0, temp_location: str = "internal"):
    """
    Return a list of [vibration, temperature, pressure] vectors that sit
    exactly on the ISA / DO-160 hard boundaries.

    These are NOT anomaly samples — they are the *edges* of the acceptable
    flight envelope.  The KMeans distance to the nearest centroid at each
    boundary point tells us how large the threshold should be so that the
    model only triggers when a reading crosses that edge.
    """
    isa_temp = isa_temperature_c(altitude_ft)
    isa_press = isa_pressure_mb(altitude_ft)
    temp_limit = EXTERNAL_TEMP_CRITICAL_C if temp_location == "external" else INTERNAL_TEMP_CRITICAL_C
    vib_normal_max = VIBRATION_NORMAL_G[1]

    return [
        # Vibration at the DO-160 critical hard limit, nominal temp & pressure
        [VIBRATION_CRITICAL_G, isa_temp, isa_press],
        # Vibration at the top of the normal band (softer boundary)
        [vib_normal_max, isa_temp, isa_press],
        # Temperature at the DO-160 thermal limit, nominal vibration & pressure
        [vib_normal_max, temp_limit, isa_press],
        # Pressure at the cabin structural minimum, nominal vibration & temp
        [vib_normal_max, isa_temp, CABIN_STRUCTURAL_MIN_PRESSURE_MB],
    ]


def compute_physics_threshold(
    model: FlightKMeansModel,
    altitude_ft: float = 0.0,
    temp_location: str = "internal",
    safety_margin: float = PHYSICS_SAFETY_MARGIN,
) -> float:
    """
    Return the physics-derived threshold: the smallest distance from any
    DO-160 boundary point to the nearest cluster centroid, scaled by
    *safety_margin*.

    A reading at or beyond a boundary point will have a distance >= this
    value, so the KMeans anomaly flag fires before the hard physical limit.
    """
    points = boundary_points(altitude_ft, temp_location)
    distances = [float(model.distances([pt])[0]) for pt in points]
    # Use the minimum so the tightest boundary dominates
    min_boundary_distance = min(distances)
    return min_boundary_distance * safety_margin


def parse_args():
    parser = argparse.ArgumentParser(
        description=(
            "Train, evaluate, and save the flight KMeans anomaly model.\n\n"
            "The anomaly threshold is anchored to ISA / DO-160 physical limits "
            "so the cluster envelope is grounded in aviation standards rather "
            "than pure statistics."
        )
    )
    parser.add_argument(
        "--data",
        help=(
            "Optional CSV of healthy samples. Use columns vibration,temperature,pressure "
            "or provide those values as the first three columns."
        ),
    )
    parser.add_argument("--model-out", default=DEFAULT_MODEL_PATH)
    parser.add_argument("--metrics-out", default=DEFAULT_METRICS_PATH)
    parser.add_argument("--clusters", type=int, default=1)
    parser.add_argument(
        "--threshold",
        type=float,
        default=None,
        help=(
            "Override the computed threshold entirely. When omitted the threshold "
            "is derived from the ISA / DO-160 boundary distances (recommended)."
        ),
    )
    parser.add_argument("--test-size", type=float, default=0.25)
    parser.add_argument("--random-state", type=int, default=42)
    parser.add_argument(
        "--altitude-ft",
        type=float,
        default=0.0,
        help="Altitude used to compute ISA reference pressure and temperature for boundary projection.",
    )
    parser.add_argument(
        "--temp-location",
        choices=["internal", "external"],
        default="internal",
        help="Sensor location used to select the correct DO-160 temperature limit.",
    )
    parser.add_argument(
        "--physics-margin",
        type=float,
        default=PHYSICS_SAFETY_MARGIN,
        help=(
            f"Safety margin applied to the physics-derived threshold "
            f"(default {PHYSICS_SAFETY_MARGIN}).  "
            "0.85 = model fires when 85 %% of the way to the hard DO-160 limit."
        ),
    )
    parser.add_argument(
        "--stat-percentile",
        type=float,
        default=95.0,
        help=(
            "Percentile of training-set distances used as the statistical "
            "threshold ceiling (default 95).  The final threshold is the "
            "lower of this and the physics-derived ceiling."
        ),
    )
    return parser.parse_args()


def main():
    args = parse_args()
    data = load_training_data(args.data)

    # ── Step 1: train with a temporarily loose threshold so we can measure
    #            boundary distances accurately before locking in the final value
    model, metrics = train_kmeans_model(
        data,
        n_clusters=args.clusters,
        threshold=args.threshold,          # None → statistical default inside kmeans_model
        test_size=args.test_size,
        random_state=args.random_state,
        stat_percentile=args.stat_percentile,
    )

    # ── Step 2: apply the ISA / DO-160 physics anchor (unless the caller
    #            supplied an explicit --threshold override)
    if args.threshold is None:
        physics_threshold = compute_physics_threshold(
            model,
            altitude_ft=args.altitude_ft,
            temp_location=args.temp_location,
            safety_margin=args.physics_margin,
        )

        # Final threshold = the tighter of physics-derived and statistical
        final_threshold = min(model.threshold, physics_threshold)

        boundary_pts = boundary_points(args.altitude_ft, args.temp_location)
        boundary_dists = [float(model.distances([pt])[0]) for pt in boundary_pts]

        print(
            f"\n[Physics anchor]\n"
            f"  Altitude            : {args.altitude_ft} ft\n"
            f"  Temp location       : {args.temp_location}\n"
            f"  DO-160 boundary distances:\n"
            f"    Vibration critical  : {boundary_dists[0]:.4f}\n"
            f"    Vibration normal max: {boundary_dists[1]:.4f}\n"
            f"    Temperature critical: {boundary_dists[2]:.4f}\n"
            f"    Pressure minimum    : {boundary_dists[3]:.4f}\n"
            f"  Min boundary distance : {min(boundary_dists):.4f}\n"
            f"  Physics threshold (×{args.physics_margin}): {physics_threshold:.4f}\n"
            f"  Statistical threshold : {model.threshold:.4f}\n"
            f"  → Final threshold     : {final_threshold:.4f} "
            f"({'physics-anchored' if final_threshold == physics_threshold else 'statistical — tighter than physics'})\n"
        )

        model.threshold = final_threshold
        metrics["threshold"] = final_threshold
        metrics["threshold_source"] = (
            "physics-anchored (ISA/DO-160)"
            if final_threshold == physics_threshold
            else "statistical (tighter than physics boundary)"
        )
        metrics["physics_threshold"] = round(physics_threshold, 6)
        metrics["statistical_threshold"] = round(
            metrics.get("statistical_threshold", model.threshold), 6
        )
        metrics["boundary_distances"] = {
            "vibration_critical": round(boundary_dists[0], 6),
            "vibration_normal_max": round(boundary_dists[1], 6),
            "temperature_critical": round(boundary_dists[2], 6),
            "pressure_minimum": round(boundary_dists[3], 6),
        }
        metrics["physics_anchor"] = {
            "altitude_ft": args.altitude_ft,
            "temp_location": args.temp_location,
            "safety_margin": args.physics_margin,
        }
    else:
        print(f"\n[Manual threshold override: {args.threshold}]\n")
        metrics["threshold_source"] = "manual override"

    # ── Step 3: save
    model_path = model.save(args.model_out)
    metrics_path = save_metrics(metrics, args.metrics_out)

    print(f"Saved model  : {model_path}")
    print(f"Saved metrics: {metrics_path}")
    print(json.dumps(metrics, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())