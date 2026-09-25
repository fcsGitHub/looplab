# 冻结评测协议 (Frozen Evaluation Protocol) v1.0

状态：**FROZEN**（冻结）。本文件一旦冻结，任何修改都必须以新版本号发布，并重新生成基线结果。

## 1. 问题定义

**一维装箱问题 (1-D Bin Packing)**：给定物品尺寸列表 `items`（正数）与箱容量 `C`，
将所有物品装入最少数量的容量为 `C` 的箱子中，每个物品不可拆分。

- 本协议固定 `C = 1.0`，物品尺寸归一化到 `(0, 1]`。
- 目标：最小化使用的箱数 `bins_used`。
- 下界：`LB = ceil(sum(items) / C)`。

## 2. 数据集（实例生成）

三类分布，每类 **≥ 200 个实例**，规模 `n ∈ {50, 100, 200}`。

| 分布 ID | 名称 | 生成方式 |
|---|---|---|
| `uniform` | 均匀分布 | `x ~ U(0.05, 1.0)` |
| `normal` | 正态分布 | `x ~ N(0.5, 0.15)`，截断到 `[0.05, 1.0]` |
| `bimodal` | 双峰分布 | 以 0.5 概率 `x ~ U(0.05, 0.35)`，否则 `x ~ U(0.65, 1.0)` |

- 每类分布 × 每个规模 `n` 生成 **200 个实例**（即每类 600 个实例，共 1800 个实例）。
- 实例由 `(distribution, n, seed)` 唯一确定，生成过程完全确定性（见 §3）。
- 物品尺寸保留 6 位小数，避免浮点不确定性。

## 3. 随机种子集合

固定种子集合（≥ 5 个），用于实例生成与任何随机化算法：

```
SEEDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
```

- 每个 `(distribution, n)` 组合使用 `SEEDS` 中的全部 10 个种子，每个种子生成 20 个实例
  （通过 `numpy.random.default_rng` 不可用，改用标准库 `random.Random`，见 §6），
  共 10 × 20 = 200 个实例。
- 实例的全局标识：`f"{distribution}-n{n}-s{seed}-i{index}"`。
- 任何算法若含随机性，必须使用同一 `SEEDS` 集合，且每个实例的算法种子 = `seed`。

## 4. 预算定义（Budget）

**主预算：总评估次数（evaluation budget）**，定义为算法对单个实例可执行的
"物品放置决策"次数上界：

```
BUDGET_EVALS_PER_INSTANCE = 10_000
```

- 一次 "评估" = 尝试将一个物品放入某个候选箱（一次可行性检查）。
- 基线启发式（FFD）为确定性构造算法，不消耗迭代预算；预算仅对后续元启发式/搜索算法生效。
- **次预算：墙钟时间上限** `WALL_CLOCK_LIMIT_PER_INSTANCE = 5.0` 秒（单实例）。
- 算法若在任一预算耗尽时未完成，则该实例记为 `timeout`，其 `bins_used = +inf`（计入最坏情况）。

## 5. 指标（Metrics）

对每个 `(distribution, n, algorithm)` 聚合以下指标：

1. **平均使用箱数** `mean_bins`：所有实例 `bins_used` 的算术平均。
2. **相对基线的改进率** `improvement_rate`：
   `(mean_bins_baseline - mean_bins_algo) / mean_bins_baseline`。
   基线 = FFD（本协议冻结的基线）。正值表示优于基线。
3. **最坏情况退化** `worst_case_degradation`：
   `max over instances of (bins_used_algo - bins_used_baseline) / bins_used_baseline`。
   即相对基线的最差单实例退化比例（可为负，表示所有实例都不差于基线）。
4. 辅助指标：`mean_gap_to_LB = mean((bins_used - LB) / LB)`，`timeout_count`。

所有指标按 `(distribution, n)` 分组报告，并给出总体（跨全部实例）汇总。

## 6. 实现约束

- 仅使用 Python 标准库（`random`, `math`, `json`, `statistics`, `time`）。
- 浮点比较使用容差 `EPS = 1e-9`。
- 实例生成使用 `random.Random(seed)`，实例 `index` 通过顺序调用生成，保证可复现。

## 7. 基线算法（Baseline）

**First Fit Decreasing (FFD)**：

1. 将物品按尺寸降序排序（稳定排序，同尺寸保持原顺序）。
2. 依次将每个物品放入第一个能容纳它的已开箱；若都不行，开新箱。

FFD 为确定性算法，无需种子。其结果为所有后续算法的比较基线。

## 8. 输出物

- `baseline_results.json`：基线在所有实例上的聚合指标 + 逐实例结果摘要 + 协议元数据（含协议哈希）。
- `protocol.md`：本文件。

## 9. 验证要求

- 每个实例必须满足：`sum(items) <= bins_used * C`（容量可行性）。
- `bins_used >= LB`。
- 实例总数必须等于 `3 分布 × 3 规模 × 200 = 1800`。
- 结果文件必须包含协议版本与种子集合，以便复现。

## 10. 版本与冻结

- 协议版本：`1.0`
- 冻结日期：见 `baseline_results.json` 的 `protocol.frozen_at`。
- 协议内容哈希：见 `baseline_results.json` 的 `protocol.protocol_sha256`。
