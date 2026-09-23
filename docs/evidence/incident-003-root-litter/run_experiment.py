"""Real fixed-budget baseline-vs-candidate experiment.

Runs every arm under the SAME budget, checks correctness against an
independent sieve ground truth, applies the decision rule, and writes
results.json. Nothing here is hard-coded: all numbers come from execution.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import baseline
import candidate_good
import candidate_bad
import eval as ev

BUDGET_OPS = ev.BUDGET_OPS
N_MAX = ev.N_MAX


def main():
    truth = ev.sieve_count(N_MAX)
    arms = {
        "baseline": baseline,
        "candidate_good": candidate_good,
        "candidate_bad": candidate_bad,
    }

    results = {}
    for name, mod in arms.items():
        results[name] = ev.evaluate(mod, truth, N_MAX, BUDGET_OPS)

    base = results["baseline"]
    good = results["candidate_good"]

    def wins(cand, ref):
        return bool(cand["correct"] and (not ref["correct"] or
                                         cand["ops_used"] < ref["ops_used"]))

    verdict = {
        "candidate_good_beats_baseline": wins(good, base),
        "candidate_bad_beats_baseline": wins(results["candidate_bad"], base),
        "candidate_bad_rejected": not results["candidate_bad"]["correct"],
    }

    out = {
        "config": {"n_max": N_MAX, "budget_ops": BUDGET_OPS,
                   "ground_truth_count": truth},
        "results": results,
        "verdict": verdict,
    }

    with open(os.path.join(HERE, "results.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, sort_keys=True)

    print(json.dumps(out, indent=2, sort_keys=True))
    return out


if __name__ == "__main__":
    main()
