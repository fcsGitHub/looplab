# 实验契约 (Experiment Contract)

**项目**：一维装箱问题 (1-D Bin Packing) 启发式优化
**版本**：v1.0
**状态**：已冻结 (Frozen) — 任何字段变更须记录于 §8 变更日志
**生成方式**：所有基线数值均由 `baseline.py` 真实运行产生（见 `baseline_results.json`），无虚构。

---

## 1. 基线算法 (Baseline)

| 字段 | 值 |
|---|---|
| 算法名称 | **First-Fit Decreasing (FFD)** |
| 来源 | Johnson, Demers, Ullman, Garey & Graham (1974), *"Worst-case performance bounds for simple one-dimensional packing algorithms"*, SIAM J. Comput. 3(4):299–325. 经典教科书算法，非本仓库私有实现。 |
| 仓库现状 | 工作区 `D:\project\looplab\data\workspaces\att_eba05d24b2bf4ebe` 为空仓库（无既有启发式函数可引用），故基线采用标准 FFD。 |
| 参考实现路径 | `baseline.py::ffd(items, capacity)` |
| 算法定义 | 将物品按尺寸**降序**排序；对每个物品，扫描已开启的箱，放入**第一个**剩余容量足够的箱（First-Fit）；若无则开启新箱。 |
| 确定性 | 完全确定，无随机性。相同输入必得相同输出（已用种子 1001 重复生成验证：`reproducible: True`）。 |
| 基线实测值 | 见 §4 表（mean / worst 箱数）。 |

---

## 2. 评测数据集 (Datasets)

**要求**：≥3 组，每组 ≥200 个实例。**满足**：3 组 × 200 实例 = 600 实例。

实例生成器：`baseline.py::gen_instances(n_inst, n_min, n_max, cap, size_lo, size_hi, seed, dist)`，使用 Python 标准库 `random.Random(seed)`（Mersenne Twister，跨平台可复现）。

| 数据集 | 实例数 | 物品数 n 范围 | 尺寸分布 | 尺寸范围 | 箱容量 | 随机种子 |
|---|---|---|---|---|---|---|
| **D1_uniform_small** | 200 | n ∈ [20, 100] | 均匀分布 uniform | [5, 60] | 100 | **1001** |
| **D2_uniform_large** | 200 | n ∈ [200, 500] | 均匀分布 uniform | [10, 90] | 150 | **2002** |
| **D3_clustered_mixed** | 200 | n ∈ [50, 300] | 双簇分布 clustered | [8, 70] | 120 | **3003** |

**生成规则细节**：
- 每个实例的 `n` 由 `rng.randint(n_min, n_max)` 抽取。
- `uniform`：每个物品尺寸 = `rng.randint(size_lo, size_hi)`。
- `clustered`：以 0.5 概率从低簇 `[size_lo, mid]` 抽取，否则从高簇 `[mid, size_hi]` 抽取，`mid = (size_lo+size_hi)//2`。
- 所有尺寸裁剪至 `[size_lo, size_hi]`，且保证 `size_hi ≤ capacity`（单物品可放入空箱）。
- 实例 ID 格式：`"{seed}-{index}"`。

**可复现性验证**：以种子 1001 两次独立生成 D1，逐实例比对结果完全一致（`reproducible: True`）。

---

## 3. 固定预算 (Budget)

| 预算项 | 上限 | 说明 |
|---|---|---|
| **候选方案评估次数** | **≤ 5000 次装箱调用** | 定义："1 次装箱调用" = 对**一个实例**完整求解一次（一次 FFD/候选算法调用）。全量评测 600 实例 = 600 次调用，占预算 12%。优化搜索（如参数调优、元启发式）额外消耗的调用次数计入此上限。 |
| **墙钟时间上限** | **≤ 300 秒**（单次完整评测 sweep，单机单线程） | 基线全量 sweep 实测 **0.2405 秒**（见 §4），预算余量 >1000×。 |
| **内存** | ≤ 2 GB | 标准库实现，实测远低于此。 |
| **硬件/环境** | 单机、单线程、Python 3.11.5 (CPython) | 记录于 `baseline_results.json` 运行环境。 |

**预算核算**：任何候选方案必须报告其消耗的装箱调用次数与墙钟时间；超预算的方案判定为**无效**，不计入验收。

---

## 4. 指标 (Metrics)

| 类型 | 指标 | 定义 |
|---|---|---|
| **主指标** | **平均使用箱数 (mean bins)** | 数据集内所有实例使用箱数的算术平均。 |
| 次指标 1 | **最坏实例箱数 (worst-case bins)** | 数据集内单实例使用箱数的最大值。 |
| 次指标 2 | **运行时间 (runtime)** | 全量 sweep 墙钟秒数，及每实例平均毫秒。 |

### 基线实测结果（真实运行，`baseline_results.json`）

| 数据集 | 实例数 | 平均箱数 (主指标) | 最坏箱数 | 最好箱数 | 全量耗时 (s) | 每实例 (ms) |
|---|---|---|---|---|---|---|
| D1_uniform_small | 200 | **19.99** | 35 | 6 | 0.0061 | 0.0307 |
| D2_uniform_large | 200 | **119.16** | 174 | 64 | 0.1382 | 0.6912 |
| D3_clustered_mixed | 200 | **57.92** | 100 | 16 | 0.0383 | 0.1913 |
| **全量 sweep** | 600 | — | — | — | **0.2405** | — |

---

## 5. 验收阈值 (Acceptance Criteria)

候选方案须**同时**满足以下全部条件方为通过：

1. **主指标（平均箱数）**：在**每个**数据集上，相对 FFD 基线的平均箱数**下降 ≥ 2%**。
   即 `(baseline_mean − candidate_mean) / baseline_mean ≥ 0.02`，对 D1、D2、D3 逐一成立。
2. **最坏实例不劣化**：在**每个**数据集上，候选方案的最坏实例箱数 **≤** FFD 基线最坏箱数（`candidate_worst ≤ baseline_worst`）。
3. **预算合规**：装箱调用次数 ≤ 5000，墙钟时间 ≤ 300 s。
4. **可复现**：使用 §2 固定种子，第三方可复现全部数值。

**判定**：4 条全部满足 → `PASS`；任一不满足 → `FAIL`。

---

## 6. 交付物与验证方式

| 交付物 | 路径 | 说明 |
|---|---|---|
| 实验契约 | `contract.md` | 本文件 |
| 基线实现 + 生成器 | `baseline.py` | FFD、实例生成器、预算核算 |
| 基线实测结果 | `baseline_results.json` | 真实运行输出（含逐实例箱数） |
| 契约自检脚本 | `verify_contract.py` | 校验契约字段完整性与基线数值可复现 |

**验证方式**：运行 `python verify_contract.py`，脚本将 (a) 检查契约必填字段齐全，(b) 重新生成数据集并重跑 FFD，比对 `baseline_results.json` 中的数值是否一致，(c) 校验预算合规。

---

## 7. 术语与约定

- **装箱调用 (bin-packing call)**：对一个实例完整执行一次求解算法。
- **实例 (instance)**：一组物品尺寸 + 一个箱容量。
- **基线 (baseline)**：FFD 在固定数据集上的结果，作为比较基准。
- 所有随机性仅来自实例生成（固定种子）；算法本身确定。

---

## 8. 变更日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 初始冻结 | 定义 FFD 基线、3×200 数据集、预算、指标与验收阈值 |
