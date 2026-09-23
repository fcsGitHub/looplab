# 诊断报告：搭建故障注入测试环境与脚本（重复失败 3 次，错误码 unknown）

## 1. 结论（TL;DR）

**根因**：执行沙箱通过 **Python `sys.audit` 审计钩子**拦截并拒绝 `subprocess.Popen` / `os.system`
（报错 `PermissionError: LOOPLAB_SANDBOX: subprocess.Popen denied`）。
而"故障注入测试环境与脚本"的**默认实现范式**（启动被测进程 → 杀进程/发信号/断网/注入崩溃）
**必然需要 spawn 子进程**。脚本在第一次 `Popen` 时抛出 `PermissionError`，
该异常未被捕获 → 任务以不透明的 `unknown` 错误失败。三次重试使用同一范式，因此**重复失败**。

**判定**：**可修复（FIX）**，不是放弃。修复方向 = 把"进程级故障注入"改为**进程内（in-process）故障注入**，
完全避免 `subprocess`。已提供可运行实现与验证（见 `fix/fault_injection_harness.py`、`verify/verify_diagnosis.py`）。

## 2. 证据（真实运行，非虚构）

### 证据 A：沙箱拒绝子进程
```
>>> subprocess.run([sys.executable, "-c", "print('hello')"])
PermissionError: LOOPLAB_SANDBOX: subprocess.Popen denied

>>> os.system("echo hi")
PermissionError: LOOPLAB_SANDBOX: os.system denied
```

### 证据 B：审计钩子机制（traceback 暴露）
```
File ".../subprocess.py", line 1534, in _execute_child
    sys.audit("subprocess.Popen", executable, args, cwd, env)
File "<string>", line 24, in _guard
File "<string>", line 15, in _deny
PermissionError: LOOPLAB_SANDBOX: subprocess.Popen denied
```
→ 沙箱在解释器内注册了 `sys.addaudithook`，命中 `subprocess.Popen` 审计事件即 `_deny`。
这与仓库 P2 提交信息中的 "Python audit-hook sandbox" 完全一致。

### 证据 C：工作区状态
- 工作树为空（仅 `.git`），Python 运行时看不到 `.git`（overlay 隔离），但 **cwd 可写**。
- 因此"写脚本文件"本身没问题；**失败点只在需要 spawn 子进程时**。

### 证据 D：失败范式复现
`fix/naive_harness_repro.py` 复现了典型写法（`Popen` 启动 SUT 再 `kill()` 注入崩溃），
稳定抛出 `PermissionError`，与 3 次失败现象吻合。

## 3. 为什么是 "unknown"

沙箱的 `PermissionError` 从 `subprocess` 内部抛出，若 harness 只捕获业务异常
（如 `TimeoutError`/`AssertionError`），该 `PermissionError` 会逃逸到任务框架，
框架将其归类为未识别的 `unknown`，而非可读的"沙箱策略拒绝"。

## 4. 修复建议（FIX）

1. **改用进程内故障注入**（推荐，已实现）：
   - 崩溃注入：monkeypatch 依赖使其 `raise`；
   - 超时注入：`threading.Thread` + `join(timeout)` 判定超时（不 spawn 进程）；
   - 数据损坏注入：包装依赖返回值；
   - 异常/重试注入：包装调用计数。
2. **不要依赖 `subprocess` / `os.system` / `multiprocessing`**（后者同样会触发 Popen 审计）。
3. **显式捕获沙箱拒绝**：在 harness 顶层捕获 `PermissionError` 并转成结构化 `sandbox_denied` 结果，
   避免再次以 `unknown` 失败。
4. 若确实需要进程级隔离，需在**沙箱策略层**放行（本任务范围内不可行），否则应放弃进程级方案。

## 5. 验证

`verify/verify_diagnosis.py` 真实运行并断言：
- 子进程被拒绝（复现根因）；
- 进程内 harness 的 4 类故障注入全部成功执行并返回预期状态。

运行结果见 `verify/verification_result.txt`。
