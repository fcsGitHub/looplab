# 事故报告 005：演示脚本 scope 映射错误导致错范围灰度发布

日期：2026-09-25　|　发现者：发布后立即核验（canary-check 对预期 scope 返回 "no pointer"）　|　状态：已纠正，流程加固

## 经过

间隙族试炼（goal_fa9c261128b24869）产生首个真实 ELIGIBLE 候选后，演示脚本
执行灰度发布。脚本中的 scope 映射是三元式：

```
scope = TASKPACK.includes("large") ? "algorithm:bin-packing-large" : "algorithm:bin-packing"
```

`algorithm-search.bin-packing-gap` 不含 "large"，落到了 **else 分支**——
间隙族候选 `cand_63e1a917cd7b4539` 被发布到小族 scope
`algorithm:bin-packing` 的指针上（rel_60c6245a5a554388，canary，ACTIVE）。

## 发现

发布后按预期 scope 执行 `canary-check`（scope=algorithm:bin-packing-gap）
返回 `{"rolledBack": false, "reason": "no pointer"}` ——预期有指针的 scope
没有指针，立即暴露错位。（幸运的是小族此前没有活跃指针，未被覆盖；但若
有，CAS 也会合法地将其顶掉——错范围发布是真破坏。）

## 纠正（全部走内核 API，无手工改库）

1. **手动回滚**：为运维补上缺失的 HTTP 面
   `POST /v1/goals/:id/releases/:releaseId/rollback`（内核 `releases.rollback`
   早已存在，仅 canary 自动监视在用）。回滚 rel_60c6245a5a554388 →
   `{"rolledBack": true}`，release/candidate 标 ROLLED_BACK，指针清除。
2. **修脚本**：scope 映射改为穷举映射（bin-packing / large / gap 各自对应）。
3. **正确 scope 重新灰度**：同一候选在 `algorithm:bin-packing-gap` 下重新
   发布 → `rel_fc218733450544ba`（canary）。
4. **回归监视**：`canary-check` → `{"rolledBack": false, "reason": "delta -1.0000 within epsilon"}`
   （负回归=改进 1 箱，监视通过）。

## 定性

- 平台内核行为全部正确：CAS、回滚、指针管理、回归监视均按合同工作。
- 缺陷在**操作面脚本**的枚举映射 + 内核缺少手动回滚的运维入口（后者使
  纠正只能先补端点——本就是该有的运维能力）。
- 事故证据链：releases 表 rel_60c6245a5a554388（ROLLED_BACK）与
  rel_fc218733450544ba（ACTIVE）、对应 events 全部保留。

## 教训

1. 枚举映射不要用"包含子串"的三元式兜底 else——默认分支应显式报错。
2. 回滚能力必须先于发布能力存在运维入口，而不是等事故时再补。
3. 发布后必须立即对**预期 scope**做一次监视查询作为发布验收步骤。
