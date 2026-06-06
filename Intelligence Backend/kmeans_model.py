import csv
import json
import os
from dataclasses import dataclass
from pathlib import Path

import joblib
import numpy as np
from sklearn.cluster import MiniBatchKMeans
from sklearn.metrics import silhouette_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler


BASE_DIR = Path(__file__).resolve().parent
MODEL_DIR = BASE_DIR / "models"
DEFAULT_MODEL_PATH = MODEL_DIR / "flight_kmeans_model.joblib"
DEFAULT_METRICS_PATH = MODEL_DIR / "flight_kmeans_metrics.json"

# The telemetry gateway prints exactly: vibration,temp,pressure
FEATURE_NAMES = ("vibration", "temperature", "pressure")

# Baseline healthy flight data in the same order as FEATURE_NAMES. These rows
# anchor the first model around ISA sea-level conditions and a normal 0.5g-1.5g
# vibration band before real aircraft telemetry is collected.
DEFAULT_HEALTHY_DATA = np.array(
    [
        [0.70, 14.6, 1012.8],
        [0.82, 15.0, 1013.2],
        [0.95, 15.2, 1011.9],
        [1.05, 14.8, 1012.6],
        [1.18, 15.4, 1013.5],
        [1.32, 14.5, 1011.4],
        [1.44, 15.6, 1014.0],
        [1.00, 15.1, 1013.0],
        [0.64, 13.8, 1009.7],
        [1.26, 16.0, 1016.1],
        [0.88, 14.2, 1010.4],
        [1.12, 15.7, 1015.0],
    ],
    dtype=float,
)

DEFAULT_ANOMALY_THRESHOLD = 3.0
MODEL_VERSION = 2


@dataclass
class FlightKMeansModel:
    pipeline: Pipeline
    threshold: float
    feature_names: tuple[str, ...] = FEATURE_NAMES

    def _as_array(self, values):
        point = np.asarray(values, dtype=float)
        if point.ndim == 1:
            point = point.reshape(1, -1)
        if point.shape[1] != len(self.feature_names):
            raise ValueError(
                f"expected {len(self.feature_names)} feature values "
                f"({', '.join(self.feature_names)}), got {point.shape[1]}"
            )
        return point

    def distances(self, values):
        points = self._as_array(values)
        scaler = self.pipeline.named_steps["scaler"]
        kmeans = self.pipeline.named_steps["kmeans"]
        scaled_points = scaler.transform(points)
        clusters = kmeans.predict(scaled_points)
        centers = kmeans.cluster_centers_[clusters]
        return np.linalg.norm(scaled_points - centers, axis=1)

    def predict(self, values):
        points = self._as_array(values)
        cluster = int(self.pipeline.predict(points)[0])
        distance = float(self.distances(points)[0])
        return {
            "cluster": cluster,
            "cluster_distance": distance,
            "anomaly": distance > self.threshold,
        }

    def supports_online_learning(self):
        return hasattr(self.pipeline.named_steps["kmeans"], "partial_fit")

    def partial_fit_nominal(self, values):
        points = self._as_array(values)
        if not self.supports_online_learning():
            return False

        scaler = self.pipeline.named_steps["scaler"]
        kmeans = self.pipeline.named_steps["kmeans"]
        scaled_points = scaler.transform(points)
        kmeans.partial_fit(scaled_points)
        return True

    def save(self, path=DEFAULT_MODEL_PATH):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump(
            {
                "version": MODEL_VERSION,
                "pipeline": self.pipeline,
                "threshold": self.threshold,
                "feature_names": self.feature_names,
            },
            path,
        )
        return path

    @classmethod
    def load(cls, path=DEFAULT_MODEL_PATH):
        artifact = joblib.load(path)
        return cls(
            pipeline=artifact["pipeline"],
            threshold=float(artifact["threshold"]),
            feature_names=tuple(artifact.get("feature_names", FEATURE_NAMES)),
        )


def load_training_data(csv_path=None):
    if not csv_path:
        return DEFAULT_HEALTHY_DATA.copy()

    rows = []
    with open(csv_path, newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames and all(name in reader.fieldnames for name in FEATURE_NAMES):
            for row in reader:
                rows.append([float(row[name]) for name in FEATURE_NAMES])
        else:
            handle.seek(0)
            plain_reader = csv.reader(handle)
            for row in plain_reader:
                if not row:
                    continue
                rows.append([float(value) for value in row[: len(FEATURE_NAMES)]])

    data = np.asarray(rows, dtype=float)
    if data.ndim != 2 or data.shape[1] != len(FEATURE_NAMES):
        raise ValueError(
            f"training data must have {len(FEATURE_NAMES)} columns: "
            f"{', '.join(FEATURE_NAMES)}"
        )
    return data


def _distance_metrics(model, data):
    distances = model.distances(data)
    predictions = distances > model.threshold
    return {
        "samples": int(len(data)),
        "mean_distance": float(np.mean(distances)),
        "max_distance": float(np.max(distances)),
        "anomaly_rate": float(np.mean(predictions)),
    }


def evaluate_model(model, train_data, test_data):
    kmeans = model.pipeline.named_steps["kmeans"]
    metrics = {
        "feature_names": list(model.feature_names),
        "threshold": float(model.threshold),
        "n_clusters": int(kmeans.n_clusters),
        "train": _distance_metrics(model, train_data),
        "test": _distance_metrics(model, test_data),
        "train_inertia": float(kmeans.inertia_),
    }

    if kmeans.n_clusters > 1 and len(test_data) > kmeans.n_clusters:
        labels = model.pipeline.predict(test_data)
        if len(set(labels)) > 1:
            scaled_test = model.pipeline.named_steps["scaler"].transform(test_data)
            metrics["test_silhouette_score"] = float(silhouette_score(scaled_test, labels))
        else:
            metrics["test_silhouette_score"] = None
    else:
        metrics["test_silhouette_score"] = None

    return metrics


def train_kmeans_model(
    data=None,
    *,
    n_clusters=1,
    threshold=None,
    test_size=0.25,
    random_state=42,
):
    data = np.asarray(DEFAULT_HEALTHY_DATA if data is None else data, dtype=float)
    if len(data) < 4:
        raise ValueError("at least 4 healthy samples are required to train and test the model")

    if threshold is None:
        threshold = float(os.getenv("ANOMALY_THRESHOLD", DEFAULT_ANOMALY_THRESHOLD))

    train_data, test_data = train_test_split(
        data,
        test_size=test_size,
        random_state=random_state,
        shuffle=True,
    )
    pipeline = Pipeline(
        steps=[
            ("scaler", StandardScaler()),
            ("kmeans", MiniBatchKMeans(
                n_clusters=n_clusters,
                n_init=10,
                random_state=random_state,
                batch_size=max(16, len(train_data)),
            )),
        ]
    )
    pipeline.fit(train_data)

    model = FlightKMeansModel(pipeline=pipeline, threshold=float(threshold))
    metrics = evaluate_model(model, train_data, test_data)
    return model, metrics


def save_metrics(metrics, path=DEFAULT_METRICS_PATH):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    return path
