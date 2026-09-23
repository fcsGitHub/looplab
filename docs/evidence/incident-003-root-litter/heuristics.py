"""Heuristic feature/model candidates (t1-t5) for the looplab task.

Each candidate is a pure function:
    fit_predict(X_train, y_train, X_eval, budget) -> (y_pred, info)

Candidates are ordered by increasing sophistication. They are heuristics
(fixed, hand-designed transforms + a linear model trained by gradient
descent), not hyper-parameter searches, so results are fully deterministic.

Scope / applicability notes are documented per candidate, including known
counter-examples where the heuristic is expected to fail.
"""
from __future__ import annotations
import numpy as np


def _sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -60, 60)))


def _fit_logreg(X, y, iters=400, lr=0.5, l2=1e-3):
    n, d = X.shape
    w = np.zeros(d)
    b = 0.0
    for _ in range(iters):
        p = _sigmoid(X @ w + b)
        g = p - y
        w -= lr * (X.T @ g / n + l2 * w)
        b -= lr * g.mean()
    return w, b


def _predict_logreg(X, w, b):
    return (_sigmoid(X @ w + b) >= 0.5).astype(np.int64)


def _standardize(Xtr, Xs):
    mu = Xtr.mean(axis=0)
    sd = Xtr.std(axis=0)
    sd[sd == 0] = 1.0
    return (Xtr - mu) / sd, (Xs - mu) / sd


def _add_squares(X, idxs):
    if not idxs:
        return X
    return np.hstack([X, np.column_stack([X[:, i] ** 2 for i in idxs])])


def _add_interactions(X, pairs):
    if not pairs:
        return X
    return np.hstack([X, np.column_stack([X[:, i] * X[:, j] for (i, j) in pairs])])
