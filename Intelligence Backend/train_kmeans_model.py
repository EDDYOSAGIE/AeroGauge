import argparse
import json

from kmeans_model import (
    DEFAULT_METRICS_PATH,
    DEFAULT_MODEL_PATH,
    load_training_data,
    save_metrics,
    train_kmeans_model,
)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Train, evaluate, and save the flight KMeans anomaly model."
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
    parser.add_argument("--threshold", type=float, default=None)
    parser.add_argument("--test-size", type=float, default=0.25)
    parser.add_argument("--random-state", type=int, default=42)
    return parser.parse_args()


def main():
    args = parse_args()
    data = load_training_data(args.data)
    model, metrics = train_kmeans_model(
        data,
        n_clusters=args.clusters,
        threshold=args.threshold,
        test_size=args.test_size,
        random_state=args.random_state,
    )

    model_path = model.save(args.model_out)
    metrics_path = save_metrics(metrics, args.metrics_out)

    print(f"Saved model: {model_path}")
    print(f"Saved metrics: {metrics_path}")
    print(json.dumps(metrics, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
