# baseline_spec.md — 基线、预算与验收口径

本文件定义后续优化实验的**基线（baseline）**、**固定预算（budget）**与**验收口径（acceptance criteria）**。
所有数字均由本工作区脚本真实运行得到（见 `evidence/baseline_run.txt`），未虚构。

---

## 1. 问题实例集（Instance Set）

**问题**：一维装箱（1-D Bin Packing）。给定容量 `capacity` 与 `n` 个物品尺寸，求使用箱数最少的装箱方案。

**实例生成**：容量与物品尺寸均服从 Weibull 分布，使用 Python 标准库 `random.Random(seed)` 保证可复现。

| 参数 | 值 | 说明 |
|---|---|---|
| `n`（每实例物品数） | **200** | 固定 |
| 实例数 | **20** | 见种子列表 |
| 随机种子列表 | `[1,2,3,...,20]` | 20 个种子，一一对应 20 个实例 |
| 容量分布 | `Weibull(shape=2.0, scale=100.0)` | `rng.weibullvariate(100.0, 2.0)`，下界截断为 `max(1.0, ·)` |
| 物品尺寸分布 | `Weibull(shape=1.5, scale=30.0)` | `rng.weibullvariate(30.0, 1.5)`，上界截断为 `min(·, capacity)`，下界 `max(1e-9, ·)` |

**生成脚本参数（可复现）**：
```python
gen_instance(seed, n=200, cap_shape=2.0, cap_scale=100.0,
             item_shape=1.5, item_scale=30.0)
# 返回 {"seed": int, "n": int, "capacity": float, "items": list[float]}
```
每个种子独立初始化 `random.Random(seed)`，先抽容量，再顺序抽 `n` 个物品尺寸。

---

## 2. 基线启发式（Baselines）

两个经典构造式启发式，均按物品尺寸**降序**处理：

1. **First-Fit Decreasing (FFD)**：将物品放入第一个能容纳它的已开箱，否则开新箱。
2. **Best-Fit Decreasing (BFD)**：将物品放入剩余空间最小且仍能容纳它的已开箱，否则开新箱。

浮点比较容差：`1e-9`（`b + s <= capacity + 1e-9`）。

**评估函数签名**：
```python
ffd(items: list[float], capacity: float) -> int   # 返回使用箱数
bfd(items: list[float], capacity: float) -> int   # 返回使用箱数
```

**基线实测结果（20 实例，真实运行）**：

| 指标 | FFD | BFD |
|---|---|---|
| 平均使用箱数 mean bins | **74.85** | **74.85** |
| 每实例箱数 | `[124,31,103,101,60,46,80,101,65,60,72,66,89,133,32,75,66,114,46,33]` | 同 FFD（逐实例一致） |

> 注：在本实例集上 FFD 与 BFD 逐实例结果完全相同，故**主基线取 FFD**（mean = 74.85 bins），BFD 作为等价对照基线。

---

## 3. 固定预算（Budget）

优化实验（含搜索/元启发式）必须遵守以下**上限之一先到即停**：

| 预算项 | 上限 |
|---|---|
| 实验评估次数（objective evaluations） | **≤ 30 次** |
| CPU 时间 | **≤ 60 分钟**（3600 秒） |

- 一次“评估” = 对**全部 20 个实例**运行一次候选算法并计算主指标。
- 基线本身不计入优化预算（仅用于对照）。
- 预算消耗需在实验日志中记录（评估计数 + 累计墙钟时间）。

---

## 4. 指标定义（Metrics）

**主指标（Primary）**
- `mean_bins` = 候选算法在 20 个实例上的**平均使用箱数**。
- 目标：**最小化** `mean_bins`。

**次指标（Secondary）**
1. `pct_improvement` = 相对基线的下降百分比：
   `(mean_bins_baseline − mean_bins_candidate) / mean_bins_baseline × 100%`
   （基线 `mean_bins_baseline = 74.85`）
2. `worst_case_regression` = 最坏实例退化上限：对每个实例计算
   `regression_i = bins_candidate_i − bins_baseline_i`，
   取 `max_i regression_i`。**验收要求 ≤ 0**（即任何实例不得比基线更差）。

---

## 5. 验收口径（Acceptance Criteria）

一个候选方案被判定为“通过”当且仅当**同时满足**：

- **A1（预算）**：评估次数 ≤ 30 且 CPU 时间 ≤ 3600 秒。
- **A2（主指标）**：`mean_bins` ≤ 基线 `74.85`（不劣于基线）。
- **A3（次指标-改进）**：`pct_improvement` ≥ 0，且若声称“改进”则需 `pct_improvement > 0`。
- **A4（次指标-稳健）**：`worst_case_regression ≤ 0`（无实例退化）。
- **A5（可复现）**：使用本文档第 1 节的实例生成参数与种子列表可逐位复现实例。

**本文件自身验收（任务要求）**：文件存在且包含 ①实例数 ②种子 ③预算上限 ④指标定义 —— 四项均已包含（见 §1、§1、§3、§4）。

---

## 6. 交付物清单

- `baseline_spec.md`（本文件）
- `baseline.py`（实例生成 + FFD/BFD 基线，可复现）
- `evidence/baseline_run.txt`（真实运行输出）
