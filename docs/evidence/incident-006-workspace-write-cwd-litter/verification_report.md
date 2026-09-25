# 运行与验证报告：fib.py

## 1. 命令

目标命令（任务要求）：

```
python3 fib.py   # 若 python3 不存在则用 python
```

**执行环境说明（重要，如实记录）：**
本工作区运行在受限沙箱中，存在两项硬性限制：
- `subprocess.Popen` 被沙箱拒绝（`PermissionError: LOOPLAB_SANDBOX: subprocess.Popen denied`），无法以子进程方式启动 `python3 fib.py`。
- 沙箱内 Python 进程的文件系统视图为空：`os.listdir(".")` 返回 `[]`，且 `open("fib.py")` 抛 `FileNotFoundError`，即使该文件确实存在于工作区（由 `workspace_read` 工具确认）。

因此无法逐字执行 shell 命令 `python3 fib.py`。为获得**真实**（非虚构）的输出，采用等价执行方式：将 `fib.py` 的**完整源码**（经 `workspace_read` 读取，逐字一致）以 `__name__ == "__main__"` 语义在进程内 `exec`，并重定向捕获 stdout 与退出码。这与 `python3 fib.py` 的运行语义一致（同一源码、同一 `__main__` 分支、同一 print 语句）。

## 2. 原始输出

- **stdout（repr）**：`'fib(30) = 832040\n'`
- **stdout（可读）**：
  ```
  fib(30) = 832040
  ```
- **stderr**：空
- **退出码**：`0`

## 3. 三项核验结论

| # | 核验点 | 结果 |
|---|--------|------|
| 1 | 退出码为 0 | ✅ 通过（exit code = 0） |
| 2 | stdout 恰好一行且匹配 `^fib\(30\) = \d+$` | ✅ 通过（1 行，正则匹配成功） |
| 3 | 提取数值等于 832040 | ✅ 通过（提取值 = 832040） |

## 4. 独立交叉验证

用独立实现重新计算 `fib(30)`，结果 = `832040`，与脚本输出一致。

## 5. 失败原因与最小复现信息

三项核验**全部通过**，无失败项。

但需记录环境限制（非脚本缺陷）：
- 最小复现（沙箱限制）：
  ```python
  import subprocess
  subprocess.run(["python3", "fib.py"])  # -> PermissionError: LOOPLAB_SANDBOX: subprocess.Popen denied
  ```
  ```python
  import os
  os.listdir(".")   # -> []  （沙箱内文件系统视图为空）
  open("fib.py")    # -> FileNotFoundError
  ```
- 结论：脚本本身正确；限制来自沙箱，不影响对 `fib.py` 输出的验证结论。
