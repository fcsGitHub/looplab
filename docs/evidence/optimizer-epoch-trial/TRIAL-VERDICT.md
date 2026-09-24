# 元演进 epoch 试炼裁决（§6.8）— gepa@0.1.4 挑战 simple-baseline@1

日期：2026-09-24　|　任务族：algorithm-search.bin-packing（冻结 dev/selection 套件，seed=7）
反射模型：DeepSeek（服务端返回模型名 `deepseek-flash`），全部经计量代理计账

## 裁决：**证据不足，保留现任**（epoch 0 → simple-baseline@1 不变）

## 试炼过程（4 次运行，全部如实记录）

| # | run | 结果 | 处置 |
|---|---|---|---|
| 1 | opt_2103888d9c94 | 无效：反射传输故障（token 未入子进程环境，全 401 静默） | FAILED，见 incident-004 |
| 2 | opt_0854239bf2b9 | 无效：沙箱 venv base-prefix 缺口使内部评分全 0（12 次反射、$0.0233 真实花费仍计账） | FAILED，提案 REJECTED，证据作废 |
| 3 | opt_88133e4f6c72 / opt_b894d1713634 | 有信号但无变体通过严格改进验收（78 例、12 反射、$0.0196）；复跑确认（78 例、12 反射、$0.0187） | 诚实空结果 |
| 4 | opt_d3dd6b111cf5 | 2 倍预算复核：159/160 例、26 反射、$0.0404 — 仍无变体严格胜过 FFD | **最终裁决依据** |

## 裁决依据

- 挑战者内部最优 = 种子（FFD）本身：GEPA 严格改进验收（strict_improvement）
  在 8+16 次迭代中未接受任何 DeepSeek 提出的变体；
- 独立 selection 套件配对比较：bins_avg 32.5 vs 32.5（delta 0 < margin 0.05）；
- 按合同（`nextEpochWinner`）：差值在 margin 内 ⇒ INCONCLUSIVE ⇒ 纪元不切换，
  挑战者不淘汰（保留 OPTIMIZER_BACKENDS 注册，复活条件：更换任务族或更大预算）。

## 成本与守恒

- 试炼总真实模型开销：≈ $0.12（含两次无效运行的全部计量花费，无一笔销账）；
- 全程零 mock 冒充：scripted fixture 仅用于 A19 契约测试，与真实运行分开；
- 证据文件：trial-goal_ca307011a07e4d5d.json（第 3 次复跑）、
  trial-goal_66e3eb801e694c89.json（第 4 次，最终裁决）。

## 机制诊断（按 §5.5 要求记录）

- 为什么打不过：FFD 在本任务族的种子实例上已处于贪心局部最优
  （FFD/BFD/WFD/合并后处理六种确定性策略全部同箱数，实测）；
- 下一次有区分度的实验：更大规模实例（items≥200，FFD 与 OPT 差距拉大）或
  接受 `improvement_or_equal` 验收 + 成本多目标（装箱数 × 运行时间）；
- 复活条件：任务族重置（新 seed archive）或预算 ≥ 10×（≥500 metric calls）。
