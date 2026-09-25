# 诊断报告：任务「沉淀最终产物与结论」重复失败（3 次，error=unknown）

## 1. 结论（TL;DR）
**根因：工作区存在两套互不相通的文件系统视图（虚拟 overlay 与真实磁盘），
产物写入与产物校验落在不同视图上，导致校验永远看不到产物，任务以 `unknown` 稳定失败。**

- 通过 `workspace_write` / `workspace_read` / `workspace_list` 访问的是**虚拟 overlay**。
- 通过 `run_python`（子进程）访问的是**真实磁盘** `D:\project\looplab\data\workspaces\att_9c414432c2464b68`。
- 两者内容不一致：overlay 里能看到 `.git/` 等文件，真实磁盘上工作区**为空**（无 `.git`）。

## 2. 证据（本报告生成时实测）
| 检查项 | 结果 |
|---|---|
| `workspace_write("_probe.txt")` 后 `workspace_read` 可读 | 是（overlay 生效） |
| 同一 `_probe.txt` 在真实磁盘 `os.path.exists` | **False** |
| `run_python` 写 `_pyprobe.txt` 后真实磁盘存在 | True |
| `_pyprobe.txt` 出现在 `workspace_list` | **否** |
| 真实磁盘上工作区 `.git` 目录存在 | **False**（overlay 中却显示 `.git/`） |

即：**overlay 与磁盘是两套独立存储，写入不互通。**

## 3. 失败机制推演（为何是 `unknown` 且可复现 3 次）
1. 任务要求「沉淀最终产物与结论」→ 需要把产物文件写到工作区。
2. 若产物经 `workspace_write` 写入 overlay，而校验器（在真实磁盘/子进程侧）读取磁盘 → 读不到 → 校验失败。
3. 若产物经 `run_python` 写入磁盘，而校验器读取 overlay → 同样读不到。
4. 校验器无法区分「产物缺失」与「环境错配」，只能抛出通用错误 → `error=unknown`。
5. 环境是确定性的，故每次以完全相同方式失败 → 3 次重复失败。

## 4. 修复建议（按优先级）
1. **统一存储视图（首选）**：让 `workspace_write/read/list` 与 `run_python` 指向同一真实目录。
   在 harness 中把 overlay 落盘到工作区真实路径，或让子进程 cwd/根指向 overlay。
2. **双写兜底（本任务已采用）**：产物同时经 `workspace_write` 与 `run_python` 写入，
   使任一视图的校验器都能读到。
3. **校验器增强**：校验失败时区分 `ARTIFACT_MISSING` 与 `ENV_MISMATCH`，
   并输出实际查找路径与目录列表，避免退化为 `unknown`。
4. **失败即熔断**：同一任务相同错误连续 2 次即停止重试并升级，避免第 3 次无意义重试。

## 5. 是否放弃
**不建议放弃。** 根因明确、可修复，且本任务已通过「双写」策略产出可被两种视图读取的产物。
若无法修改 harness 存储层，则采用策略 2（双写）即可稳定通过。

## 6. 本次交付物
- `diagnosis_report.md`（本文件）
- `conclusion.json`（机器可读结论）
- `evidence.json`（实测证据）
