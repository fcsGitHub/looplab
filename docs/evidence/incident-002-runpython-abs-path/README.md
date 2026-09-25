# 事故 002：run_python 允许绝对路径读写（越出工作区）

- 发现时间：2026-09-24 03:16（真实目标执行中的 Reviewer 阶段）
- 现象：verify.py、run_log.txt、primes_count.py 出现在仓库根。Reviewer 的
  run_python 以绝对路径访问了 D:\project\looplab 下的文件。
- 根因：run_python 仅约束子进程 cwd（相对路径安全），未限制脚本内的绝对
  路径 open()。模型在验证阶段自行探索了仓库根。
- 修复：把评测器同款 PEP 578 审计钩子移植进 run_python 引导段：
  工作区外 open/重命名/删除一律拒绝，socket/subprocess 一律拒绝；
  拒绝事件写 fd2 并带 LOOPLAB_SANDBOX 标记，工具结果记失败。
- 残余边界（已在威胁模型登记）：同 OS 用户下的进程级隔离非内核级沙箱；
  容器/Job Object 隔离列为增强项。
