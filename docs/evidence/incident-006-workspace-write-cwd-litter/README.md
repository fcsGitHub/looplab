# 事故报告 006：workspace_write 相对路径按 worker 进程 CWD 解析 → 仓库根散落

日期：2026-09-25　|　发现者：提交前 `git status` 审查发现仓库根出现 22 个 soak 目标交付物　|　状态：已修复并有回归测试

## 现象

30 分钟 soak 期间（goal 文本："写 fib.py 并运行验证"等），worker `final-01`
正常执行并 COMMITTED，但交付物（fib.py、stats.py、vowels.py、factorial.py、
各类 review/verify 报告共 22 个文件）出现在**仓库根目录**而非
`data/workspaces/<attemptId>/` 沙箱。

## 根因：策略判定与执行的路径解析不一致

- 服务端 PolicyGate（`packages/policy`）判定 `workspace_write` 时把相对路径
  **对照 attempt workspace 解析** → "fib.py" 在工作区内 → 允许。
- worker 执行器（`CapabilityGateway.execute` 的 `workspace_write`）却把
  `args.path` **原文**交给 `fs.writeFile` → 相对路径对照**worker 进程 CWD**
  （= 仓库根）解析 → 写穿。
- 读（workspace_read）与列目录（workspace_list 的 path 参数）有同样的缺口
  （可越界读）。

这是 incident-001/002 之后的第三类路径解析缺口：前两次堵的是 run_python
（cwd 静默回退、绝对路径 open），这次是 **worker 自己的工具执行器**——
它不在 python 审计钩子的保护范围内，此前从未被收容断言覆盖。
gw-hardening 断言集只覆盖了 run_python，未覆盖 workspace_*。

## 为什么现在才爆发

round 1 的垂直链路中提示词/模型行为恰好主要使用绝对路径写入沙箱；
soak 的批量目标让模型稳定地按提示用相对路径写 → 每个目标都在 CWD 留下文件。
缺口一直存在，只是从未被稳定触发。

## 修复

`CapabilityGateway` 新增 `contain()`：所有 workspace_* 工具的路径参数
**先对照 workspaceDir 解析再执行**，越界（`../`、绝对路径在外）一律拒绝并
返回 `ERROR: path escapes workspace`。解析规则与服务端 PolicyGate 完全一致。

回归测试：`tests/unit/gateway-containment.test.ts`（4 项）——
相对路径落入沙箱而非 CWD、`../` 拒绝、外部绝对路径 write/read/list 全拒、
工作区根本身可寻址。

## 处置

- 22 个散落文件整体移入 `docs/evidence/incident-006-workspace-write-cwd-litter/`
  存档（git mv，保留历史）；误随 P8 提交（39bc23c）入库，由本修复提交迁出。
- 事故链证据：attempts（att_4180bd6669bb4f79 等）的 attempt_specs 记录了
  正确的 workspace_dir，与文件实际落点对比即根因证明。

## 教训

1. **判定与执行必须共享同一套路径解析**——策略说"允许"不代表执行器解析到
   同一个文件。
2. 收容断言要覆盖每一个触碰文件系统的执行器（含 worker 自身工具），不能只
   覆盖最显眼的子进程沙箱。
3. soak 型批量负载是最好的缺口暴露器：单一演示路径的"看起来正常"不算证据。
