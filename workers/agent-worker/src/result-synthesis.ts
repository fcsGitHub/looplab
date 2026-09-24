// Shared RESULT-settlement policy for both runtimes (problem ledger #1).
// The old failure mode: the model does real work but ends without a
// parseable RESULT, the attempt failed or committed with verification=null,
// and the retry burned the full budget again. Settlement is now explicit:
//   - parseable RESULT       -> pass through the model's claim verbatim
//   - unparseable + text     -> SUCCEEDED with an honest result_format
//                               verification (passed=false): the work product
//                               stands, the quality signal is preserved
//   - unparseable + no text  -> FAILED ("无输出"): retry is justified, nothing
//                               was produced
// The forced wrap-up instruction (tools disabled on the last turn) is shared
// so both runtimes end the same way under a step budget.
import type { LoopOutcome } from "./agent-loop.js";

export const FORCED_WRAPUP_INSTRUCTION =
  "[系统] 已到步数上限：禁止再调用工具，立即基于已知信息按格式输出 RESULT（outcome 如实）。";

/** The upcoming model call is the last one the budget allows (turns are
 *  0-based completed calls). Mirrors the loop runtime's historical rule. */
export function isForcedWrapUpTurn(completedTurns: number, maxTurns: number): boolean {
  return completedTurns >= maxTurns - 1;
}

export interface Settlement {
  outcome: "SUCCEEDED" | "FAILED";
  summary: string;
  verification: LoopOutcome["verification"];
}

export function settleRunResult(input: {
  parsed: {
    summary: string; outcome: "SUCCEEDED" | "FAILED";
    verification: { kind: string; passed: boolean; detail: string } | null;
  } | null;
  finalText: string | null;
}): Settlement {
  if (input.parsed) {
    return {
      outcome: input.parsed.outcome,
      summary: input.parsed.summary,
      verification: input.parsed.verification,
    };
  }
  const text = (input.finalText ?? "").trim();
  if (text) {
    return {
      outcome: "SUCCEEDED",
      summary: text.slice(0, 800),
      verification: {
        kind: "result_format",
        passed: false,
        detail: "模型未按 RESULT 格式收尾（重问后仍不可解析）；结果由运行时按最后陈述合成，交付物以确定性工作区快照为准",
      },
    };
  }
  return {
    outcome: "FAILED",
    summary: "无输出：模型未产生可用的收尾陈述",
    verification: {
      kind: "result_format",
      passed: false,
      detail: "无 RESULT 且无最终文本；重试合理（本 attempt 未产出可采信内容）",
    },
  };
}
