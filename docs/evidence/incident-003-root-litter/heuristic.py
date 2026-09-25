"""改进启发式候选：0/1 背包问题的贪心 + 局部交换改进。

背景：重复失败任务的唯一可执行内核是“实现改进启发式候选”。
本模块提供两个启发式：
  - baseline_greedy: 经典按价值密度降序贪心。
  - improved_heuristic: 密度贪心 + 单点替换 + 双点交换的局部搜索（候选改进）。

全部为标准库实现，确定性（固定随机种子），可复现。
"""
from __future__ import annotations
import random
from dataclasses import dataclass
from typing import List, Tuple


@dataclass
class Item:
    weight: int
    value: int


def gen_instance(n: int, seed: int, max_w: int = 50, max_v: int = 50) -> Tuple[List[Item], int]:
    rng = random.Random(seed)
    items = [Item(rng.randint(1, max_w), rng.randint(1, max_v)) for _ in range(n)]
    capacity = max(1, int(sum(it.weight for it in items) * 0.4))
    return items, capacity


def _total(items: List[Item], chosen: List[bool]) -> Tuple[int, int]:
    w = sum(it.weight for it, c in zip(items, chosen) if c)
    v = sum(it.value for it, c in zip(items, chosen) if c)
    return w, v


def baseline_greedy(items: List[Item], capacity: int) -> Tuple[List[bool], int]:
    """按价值密度降序贪心放入。"""
    order = sorted(range(len(items)), key=lambda i: items[i].value / items[i].weight, reverse=True)
    chosen = [False] * len(items)
    w = 0
    for i in order:
        if w + items[i].weight <= capacity:
            chosen[i] = True
            w += items[i].weight
    return chosen, _total(items, chosen)[1]


def improved_heuristic(items: List[Item], capacity: int) -> Tuple[List[bool], int]:
    """改进候选：密度贪心 + 单点替换 + 双点交换局部搜索。"""
    chosen, _ = baseline_greedy(items, capacity)
    w, v = _total(items, chosen)

    improved = True
    while improved:
        improved = False
        # 单点替换：用未选物品替换一个已选物品，提升价值且不超容量
        for i in range(len(items)):
            if not chosen[i]:
                for j in range(len(items)):
                    if chosen[j]:
                        nw = w - items[j].weight + items[i].weight
                        nv = v - items[j].value + items[i].value
                        if nw <= capacity and nv > v:
                            chosen[j] = False
                            chosen[i] = True
                            w, v = nw, nv
                            improved = True
                            break
            if improved:
                break
        if improved:
            continue
        # 双点交换：加入两个未选、移除一个已选
        for i in range(len(items)):
            if chosen[i]:
                continue
            for k in range(i + 1, len(items)):
                if chosen[k]:
                    continue
                for j in range(len(items)):
                    if not chosen[j]:
                        continue
                    nw = w - items[j].weight + items[i].weight + items[k].weight
                    nv = v - items[j].value + items[i].value + items[k].value
                    if nw <= capacity and nv > v:
                        chosen[j] = False
                        chosen[i] = True
                        chosen[k] = True
                        w, v = nw, nv
                        improved = True
                        break
                if improved:
                    break
            if improved:
                break
    return chosen, v


def run_benchmark(n: int = 60, seeds: int = 30) -> dict:
    """在固定种子上对比 baseline 与 improved。"""
    base_vals, imp_vals, wins, ties = [], [], 0, 0
    for s in range(seeds):
        items, cap = gen_instance(n, seed=s)
        _, bv = baseline_greedy(items, cap)
        _, iv = improved_heuristic(items, cap)
        base_vals.append(bv)
        imp_vals.append(iv)
        if iv > bv:
            wins += 1
        elif iv == bv:
            ties += 1
    total_b = sum(base_vals)
    total_i = sum(imp_vals)
    return {
        "n_items": n,
        "seeds": seeds,
        "baseline_total_value": total_b,
        "improved_total_value": total_i,
        "abs_gain": total_i - total_b,
        "rel_gain_pct": round(100.0 * (total_i - total_b) / total_b, 4) if total_b else 0.0,
        "wins": wins,
        "ties": ties,
        "losses": seeds - wins - ties,
    }


if __name__ == "__main__":
    import json
    print(json.dumps(run_benchmark(), indent=2))
