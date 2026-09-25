# 事故 001：run_python 子进程 CWD 落到控制服务仓库根目录

- 发现时间：2026-09-24 01:16（首个多角色任务执行中）
- 现象：Experimenter/Reviewer 角色通过 run_python 写出的文件出现在仓库根目录
  （prime.py、review_prime.py、case_manifest.md 等），而非 attempt 工作区
  `data/workspaces/<attempt_id>/`。
- 影响：违反「候选代码不接触控制服务目录」的威胁模型边界（docs/architecture/threat-model.md）。
  本目录中的文件即当时逃逸产物的原始证据。
- 定位：由 01:13 启动的旧 worker 进程执行；以当时代码原地复现未果。
  01:33 后三个独立验证（scripts/cwdprobe、tests/manual/gw-probe、真实 agent 内
  run_python 写 cwd_probe_out.txt）均确认 CWD 正确落在 attempt 工作区。
- 加固（防止同类静默回退）：
  1. capability-gateway.ts：python 子进程内强制 os.chdir(工作区) + realpath 校验，
     不符即 exit(126)（SANDBOX VIOLATION），工具结果记失败。
  2. spawn cwd 选项保留为第一道防线。
- 残余风险（登记）：Python 内 os.chdir() 到任意路径仍可能；完全遏制需 OS 级
  沙箱（Job Object / 容器），列为 P5 增强项。
