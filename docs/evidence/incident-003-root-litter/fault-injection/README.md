# Fault Injection Test Environment

A reproducible fault-injection harness for a small HTTP "target" service
(`target-api`). It ships two interchangeable runtimes:

| Runtime | Entry point | Requires | Purpose |
|---|---|---|---|
| **Container** (primary) | `docker-compose.yml` | Docker + Docker Compose | One-command bring-up of target + injector sidecar |
| **In-process** (reference) | `engine/run_demo.py` | Python 3.8+ stdlib only | Same fault logic, no Docker/network needed; used for CI and for verifying the fault model itself |

Both runtimes implement the **same fault catalogue** and the **same
parameterisation** (`--fault`, `--intensity`, `--duration`), so a scenario
validated in-process behaves identically under Compose.

---

## 1. Fault catalogue

| Fault | `--fault` | Intensity meaning | Observable symptom |
|---|---|---|---|
| Latency injection | `latency` | added delay in ms | p95 latency rises by ~intensity |
| Error injection | `error` | error rate 0.0–1.0 | fraction of requests return 5xx |
| CPU saturation | `cpu` | worker threads blocked, 1–N | throughput collapses, latency rises |
| Memory pressure | `memory` | MB allocated per request | RSS grows, latency rises |
| Network partition | `partition` | drop rate 0.0–1.0 | fraction of calls fail to reach target |

Faults are **parameterised by intensity and duration**; the injector
auto-reverts when the duration elapses (`--duration` seconds, `0` = until
explicitly cleared).

---

## 2. Container runtime (primary)

```bash
cd fault-injection
docker compose up -d --build          # start target-api + injector
./scripts/inject.sh latency 300 30    # +300ms latency for 30s
./scripts/observe.sh                  # sample the target, print health
./scripts/cleanup.sh                  # clear faults + tear down
```

* `docker-compose.yml` — target service + injector sidecar on a shared network.
* `scripts/inject.sh` — POSTs a fault spec to the injector control API.
* `scripts/observe.sh` — polls `/health` and `/metrics`, prints a table.
* `scripts/cleanup.sh` — clears all faults, then `docker compose down -v`.

## 3. In-process runtime (reference / CI)

```bash
python engine/run_demo.py --fault latency --intensity 300 --duration 2
python engine/run_demo.py --fault error   --intensity 0.5 --duration 2
python engine/run_demo.py --fault cpu     --intensity 4   --duration 2
python engine/run_demo.py --fault memory  --intensity 8   --duration 2
python engine/run_demo.py --fault partition --intensity 0.5 --duration 2
python engine/run_demo.py --selftest      # runs every fault, asserts symptoms
```

`run_demo.py` drives a real in-process `TargetService` through a
`FaultInjector`, issues a workload, and prints a **before / during / after**
comparison. It exits non-zero if the fault did not produce the expected
symptom or if the system did not recover after cleanup — this is the
automated acceptance check.

## 4. Acceptance criteria

1. After `start`, injecting ≥1 fault produces a measurable anomaly.
2. After `cleanup`, the target returns to its baseline behaviour.

`engine/run_demo.py --selftest` asserts both for all five faults.

## 5. Layout

```
fault-injection/
├── docker-compose.yml
├── Dockerfile.target
├── Dockerfile.injector
├── README.md
├── engine/
│   ├── faults.py        # fault catalogue + FaultInjector
│   ├── target.py        # in-process TargetService (the SUT)
│   ├── run_demo.py      # CLI: inject, observe, cleanup, --selftest
│   └── selftest.py      # acceptance assertions
├── injector/
│   └── app.py           # HTTP control API wrapping the same FaultInjector
├── target/
│   └── app.py           # HTTP target service (the SUT)
└── scripts/
    ├── start.sh
    ├── inject.sh
    ├── observe.sh
    └── cleanup.sh
```
