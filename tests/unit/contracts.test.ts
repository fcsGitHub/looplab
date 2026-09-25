// Unit tests for P0 contracts: state machines + graph compiler (design §6.2, §7.2).
import { describe, expect, it } from "vitest";
import {
  GOAL_TRANSITIONS, TASK_TRANSITIONS, ATTEMPT_TRANSITIONS, CANDIDATE_TRANSITIONS,
  canTransition,
} from "../../packages/contracts/src/states.js";
import { compileGraph, affectedSubgraph } from "../../packages/contracts/src/graph.js";

describe("state machines", () => {
  it("goal: user pause only resumes via explicit command", () => {
    expect(canTransition(GOAL_TRANSITIONS, "ACTIVE", "PAUSED_USER")).toBe(true);
    expect(canTransition(GOAL_TRANSITIONS, "PAUSED_USER", "ACTIVE")).toBe(true);
    // WAITING_RESOURCE must never auto-transition from/to arbitrary states
    expect(canTransition(GOAL_TRANSITIONS, "COMPLETED", "ACTIVE")).toBe(false);
    expect(canTransition(GOAL_TRANSITIONS, "CANCELLED", "ACTIVE")).toBe(false);
  });

  it("attempt: RESULT_PENDING never auto-retries to RUNNING (forces reconcile)", () => {
    expect(canTransition(ATTEMPT_TRANSITIONS, "RESULT_PENDING", "RUNNING")).toBe(false);
    expect(canTransition(ATTEMPT_TRANSITIONS, "RESULT_PENDING", "RECONCILE_REQUIRED")).toBe(true);
    expect(canTransition(ATTEMPT_TRANSITIONS, "LOST", "READY")).toBe(false);
    expect(canTransition(ATTEMPT_TRANSITIONS, "RUNNING", "COMMITTED")).toBe(true);
  });

  it("candidate: RELEASED can only roll back; REJECTED is terminal", () => {
    expect(canTransition(CANDIDATE_TRANSITIONS, "RELEASED", "PROPOSED")).toBe(false);
    expect(canTransition(CANDIDATE_TRANSITIONS, "RELEASED", "ROLLED_BACK")).toBe(true);
    expect(canTransition(CANDIDATE_TRANSITIONS, "REJECTED", "EVALUATING")).toBe(false);
    expect(canTransition(CANDIDATE_TRANSITIONS, "INCONCLUSIVE", "EVALUATING")).toBe(true);
  });

  it("task: failed tasks may be reopened by re-planning", () => {
    expect(canTransition(TASK_TRANSITIONS, "FAILED", "READY")).toBe(true);
    expect(canTransition(TASK_TRANSITIONS, "SUCCEEDED", "RUNNING")).toBe(false);
  });
});

describe("graph compiler", () => {
  const baseNodes = [
    { key: "a", role: "Coordinator", kind: "model", title: "A", instruction: "do a", depends_on: [], risk_class: "low" },
    { key: "b", role: "Builder", kind: "model", title: "B", instruction: "do b", depends_on: ["a"], risk_class: "low" },
    { key: "c", role: "Reviewer", kind: "review", title: "C", instruction: "review b", depends_on: ["b"], risk_class: "low" },
  ];

  it("accepts a clean DAG and computes topo order + successors", () => {
    const res = compileGraph({ version: "g1", nodes: baseNodes, loops: [] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.topoOrder).toEqual(["a", "b", "c"]);
      expect(res.value.successors["a"]).toEqual(["b"]);
      expect(res.value.entryNodes).toEqual(["a"]);
    }
  });

  it("rejects undeclared cycles", () => {
    const nodes = [
      ...baseNodes,
      { key: "d", role: "Builder", kind: "model", title: "D", instruction: "fix", depends_on: ["c"], risk_class: "low" },
      // back edge creating a cycle b -> c -> d -> b without a declaration
      { key: "e", role: "Builder", kind: "model", title: "E", instruction: "e depends d; d2 depends e", depends_on: ["d"], risk_class: "low" },
    ];
    // make a real cycle: d depends on e? d already depends on c; add f depending on e, and c depending on f
    const nodes2 = [...nodes,
      { key: "f", role: "Builder", kind: "model", title: "F", instruction: "loop back", depends_on: ["e"], risk_class: "low" },
    ];
    // now declare b->...: modify c to depend on f as well via raw graph edit
    const withCycle = nodes2.map((n) => (n.key === "c" ? { ...n, depends_on: ["b", "f"] } : n));
    const res = compileGraph({ version: "g2", nodes: withCycle, loops: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === "undeclared_cycle")).toBe(true);
  });

  it("accepts a bounded declared loop but rejects unbounded / missing exit", () => {
    const loopNodes = [
      baseNodes[0],
      { key: "b", role: "Builder", kind: "model", title: "B", instruction: "do b", depends_on: [], risk_class: "low" },
      { key: "c", role: "Reviewer", kind: "review", title: "C", instruction: "review", depends_on: ["b"], risk_class: "low" },
      { key: "b2", role: "Builder", kind: "model", title: "B2", instruction: "revise", depends_on: ["c"], risk_class: "low" },
    ];
    const declared = compileGraph({
      version: "g3",
      nodes: loopNodes,
      loops: [{ back_edge: { from: "b2", to: "b" }, max_visits: 2, exit_condition: "review PASS or budget exhausted" }],
    });
    expect(declared.ok).toBe(true);

    const unbounded = compileGraph({
      version: "g4",
      nodes: loopNodes,
      loops: [{ back_edge: { from: "b2", to: "b" }, max_visits: 0, exit_condition: "x" }],
    });
    expect(unbounded.ok).toBe(false);
    if (!unbounded.ok) expect(unbounded.errors.some((e) => e.code === "unbounded_loop")).toBe(true);

    const noExit = compileGraph({
      version: "g5",
      nodes: loopNodes,
      loops: [{ back_edge: { from: "b2", to: "b" }, max_visits: 2, exit_condition: "" }],
    });
    expect(noExit.ok).toBe(false);
  });

  it("affected subgraph = failed node + successors only", () => {
    const res = compileGraph({ version: "g6", nodes: baseNodes, loops: [] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(affectedSubgraph(res.value, "b")).toEqual(new Set(["b", "c"]));
      expect(affectedSubgraph(res.value, "a")).toEqual(new Set(["a", "b", "c"]));
    }
  });
});
