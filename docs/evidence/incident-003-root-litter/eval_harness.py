"""Reproducible evaluation harness + baseline.

Constraint discovered during diagnosis: the sandbox denies subprocess.Popen and
any open() outside the attempt workspace (including tempfile dirs and 'nul').
Therefore this harness is:
  * pure standard library
  * subprocess-free
  * tempfile-free (all artifacts written inside the workspace)
  * deterministic (fixed seed, no wall-clock / no randomness in the metric)

It defines a tiny, fully-specified benchmark task, a reference baseline, and a
reproducible scoring procedure. Running it twice must yield identical numbers.
"""
import hashlib
import json
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = 12345
N_ITEMS = 200


def make_dataset(seed=SEED, n=N_ITEMS):
    """Deterministic synthetic dataset: (x, y) with y = 3*x + 2 + noise."""
    rng = random.Random(seed)
    data = []
    for _ in range(n):
        x = rng.uniform(-10.0, 10.0)
        noise = rng.gauss(0.0, 0.5)
        y = 3.0 * x + 2.0 + noise
        data.append((x, y))
    return data


def split(data, frac=0.7):
    """Deterministic train/test split (no shuffling randomness beyond index)."""
    k = int(len(data) * frac)
    return data[:k], data[k:]


def baseline_fit(train):
    """Closed-form least-squares baseline: y = a*x + b."""
    n = len(train)
    sx = sum(x for x, _ in train)
    sy = sum(y for _, y in train)
    sxx = sum(x * x for x, _ in train)
    sxy = sum(x * y for x, y in train)
    denom = n * sxx - sx * sx
    a = (n * sxy - sx * sy) / denom
    b = (sy - a * sx) / n
    return a, b


def mse(model, data):
    a, b = model
    return sum((a * x + b - y) ** 2 for x, y in data) / len(data)


def run():
    data = make_dataset()
    train, test = split(data)
    model = baseline_fit(train)
    train_mse = mse(model, train)
    test_mse = mse(model, test)

    # Reproducibility fingerprint of the dataset itself.
    blob = json.dumps(data, sort_keys=True).encode()
    data_hash = hashlib.sha256(blob).hexdigest()

    result = {
        "seed": SEED,
        "n_items": len(data),
        "n_train": len(train),
        "n_test": len(test),
        "baseline": {"a": round(model[0], 6), "b": round(model[1], 6)},
        "train_mse": round(train_mse, 6),
        "test_mse": round(test_mse, 6),
        "dataset_sha256": data_hash,
    }
    return result


if __name__ == "__main__":
    r = run()
    out = os.path.join(HERE, "eval_result.json")
    with open(out, "w") as f:
        json.dump(r, f, indent=2, sort_keys=True)
    print(json.dumps(r, indent=2, sort_keys=True))
