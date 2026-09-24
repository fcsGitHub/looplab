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

---

# 补充裁决（2026-09-25）：大实例族 + 等协议试炼

按上一节"复活条件"重启试炼：新任务族 `algorithm-search.bin-packing-large`
（每实例 220 件物品、容量 100，seed archive 4xxx/5xxx/6xxx 与小族完全隔离），
并把现任优化器 simple-baseline@1 也注册到 OptimizerPort 上以**同一协议**竞争
（一次真实 LLM 提案，经同一 completeRun 合同与独立三层评测）。

## 结果（goal_400e49a41ee644ab）

| 后端 | 模式 | 用量 | 独立评测（selection） |
|---|---|---|---|
| simple-baseline@1（现任） | active | 1 次 LLM，$0.0007 | INCONCLUSIVE：bins_avg 114.7 vs 114.7，delta=0 |
| gepa@0.1.4（挑战者） | epoch_trial | 13 次反射 + 80/80 评估，$0.0212 | 无提案：严格改进验收未通过任何变体 |

结算：`difference 0.0000 within margin 0.05: 证据不足，保留现任`（epoch 0 不变）。

## 解读

- FFD 在均匀随机装箱实例上接近贪心最优：220 件物品下 simple-baseline 的
  LLM 提案同样只能打平（delta=0），与挑战者的空结果互相印证；
- 预算内（80 metric calls ≈ 10 次迭代）GEPA 未能找到严格改进——**不是平台
  缺陷，是任务族信息量不足**；下一纪元若要产出有区分度的试炼，需要：
  1. 存在已知次优间隙的实例族（如几乎所有 optimal 装箱基准集，
     FF/BFD 与 OPT 有 2-11% 已知差距的构造性实例）；
  2. 或把验收改为 improvement_or_equal + 成本多目标。
- 平台侧本轮真正关闭的是协议对称性：现任与挑战者现在走完全相同的
  注册、预算、评测与结算路径，历史对照（现任 delta 恒为 0 的假设）不再需要。

## 成本

本轮试炼真实模型开销 ≈ $0.022（全部计量入账）。证据：
`trial-algorithm-search.bin-packing-large-goal_400e49a41ee644ab.json`。
