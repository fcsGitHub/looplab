// Problem ledger #1: RESULT settlement policy shared by both runtimes.
// A model that does real work but ends without a parseable RESULT must not
// silently commit with verification=null (no quality signal) nor fail the
// whole attempt (budget burned on retry). The settlement rules and the
// forced-wrap-up turn boundary are the contract here.
import { describe, expect, it } from "vitest";
import {
  FORCED_WRAPUP_INSTRUCTION,
  isForcedWrapUpTurn,
  settleRunResult,
} from "../../workers/agent-worker/src/result-synthesis.js";

const okParsed = {
  summary: "做了事",
  outcome: "SUCCEEDED" as const,
  verification: { kind: "真实运行", passed: true, detail: "3/3 通过" },
};

describe("settleRunResult", () => {
  it("parseable RESULT passes through verbatim (model's claim is the claim)", () => {
    const s = settleRunResult({ parsed: okParsed, finalText: "RESULT {...}" });
    expect(s.outcome).toBe("SUCCEEDED");
    expect(s.summary).toBe("做了事");
    expect(s.verification).toEqual(okParsed.verification);
  });

  it("unparseable RESULT but substantive text: SUCCEEDED with honest result_format signal (passed=false)", () => {
    const s = settleRunResult({ parsed: null, finalText: "我完成了工作，但忘了格式。" });
    expect(s.outcome).toBe("SUCCEEDED");
    expect(s.summary).toContain("我完成了工作");
    expect(s.verification?.kind).toBe("result_format");
    expect(s.verification?.passed).toBe(false);
    expect(s.verification?.detail).toContain("未按 RESULT 格式");
  });

  it("long unformatted text is truncated to 800 chars", () => {
    const s = settleRunResult({ parsed: null, finalText: "x".repeat(2000) });
    expect(s.summary.length).toBe(800);
  });

  it("no RESULT and no text: FAILED (retry is justified, nothing produced)", () => {
    const s = settleRunResult({ parsed: null, finalText: null });
    expect(s.outcome).toBe("FAILED");
    expect(s.summary).toContain("无输出");
    expect(s.verification?.passed).toBe(false);
    const s2 = settleRunResult({ parsed: null, finalText: "   \n  " });
    expect(s2.outcome).toBe("FAILED");
  });
});

describe("isForcedWrapUpTurn", () => {
  it("last allowed turn triggers the wrap-up; earlier turns do not", () => {
    expect(isForcedWrapUpTurn(0, 16)).toBe(false);
    expect(isForcedWrapUpTurn(14, 16)).toBe(false);
    expect(isForcedWrapUpTurn(15, 16)).toBe(true); // 16th call is the last
  });

  it("defensive: over-budget turns still force the wrap-up", () => {
    expect(isForcedWrapUpTurn(20, 16)).toBe(true);
  });

  it("the instruction forbids tools and demands an honest RESULT", () => {
    expect(FORCED_WRAPUP_INSTRUCTION).toContain("禁止再调用工具");
    expect(FORCED_WRAPUP_INSTRUCTION).toContain("RESULT");
    expect(FORCED_WRAPUP_INSTRUCTION).toContain("如实");
  });
});
