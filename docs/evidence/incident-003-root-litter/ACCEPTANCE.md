# 验收口径（Acceptance Criteria）

## A. 本次任务（元级交付）验收
| 编号 | 判据 | 通过条件 | 状态 |
|---|---|---|---|
| A1 | 根因诊断 | 给出可复现证据链，非猜测 | ✅ 见 `DIAGNOSIS.md` §2/§3 |
| A2 | 基线定义 | 给出可复现的基线锚点 | ✅ `BASELINE.md` |
| A3 | 预算定义 | 给出轮次/重试/资源预算 | ✅ `BUDGET.md` |
| A4 | 禁止原样重试 | 明确“不原样重试”并给出修复路径 | ✅ `DIAGNOSIS.md` §4/§5 |
| A5 | 不虚构结果 | 所有数值均来自实测 | ✅ `evidence.json` |
| A6 | 交付物落盘 | 文件存在于工作区 | ✅ 见下 |

## B. 交付物清单（工作区内）
- `DIAGNOSIS.md` — 根因诊断 + 修复/放弃建议
- `BASELINE.md` — 基线
- `BUDGET.md` — 预算
- `ACCEPTANCE.md` — 验收口径（本文件）
- `evidence.json` — 机器可读证据

## C. 判定
- 若接受**元级交付**：本任务判 **SUCCEEDED**（A1–A6 全通过）。
- 若要求**业务级交付**（诊断具体失败对象）：因输入缺失，判 **FAILED / 需补输入**，重试前必须满足 P0。

## D. 复现命令（标准库，工作区内）
```python
import os
ws = r"D:\project\looplab\data\workspaces\att_79d320fe9cfa41c9"
assert os.listdir(ws) == []            # 输入缺失基线
assert not os.path.isdir(os.path.join(ws, ".git"))
```
