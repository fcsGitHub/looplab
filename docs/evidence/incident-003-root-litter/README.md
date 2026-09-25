# 事故 003：旧 worker（无文件访问审计钩子）造成仓库根大面积散落文件

- 发现时间：2026-09-24 03:55
- 范围：约 80 个文件/目录（_diag_*、candidate_*、review_*、verify_*、
  vowels.py、fib.py、stats.py、faultlab/ 等），均为各目标（soak/E2E/演示）
  执行期间由模型经 run_python 以绝对路径写入仓库根。
- 根因：审查钩子（PEP 578 audit hook）修复后，旧 worker 进程（ui-02/ui-03
  早期实例）未重启，继续以无文件访问限制的代码执行新任务。
- 本目录中的文件即散落产物的原样归档（事故证据，保持可追溯）。
- 修复与流程改进：
  1. capability-gateway.ts 的 run_python 引导段加入完整审计钩子
     （open/重命名/删除越出工作区即拒绝；socket/subprocess 全拒）。
  2. worker 更新代码后必须重启——在 runbook 中加入「部署 worker 修复后
     先以 tests/manual/gw-hardening.ts 验证再上线」步骤。
  3. 测试断言：tests/manual/gw-hardening.ts（相对写 OK、绝对读阻断、socket 阻断）。
