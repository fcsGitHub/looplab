// PolicyGate: the execute-before authority (design §三.5, §二).
// A tool call is executed only if the gate says so — event subscription is
// NOT a security boundary. The gate is pure: same inputs, same decision.
import path from "node:path";

export interface ToolCallRequest {
  tool: string;
  args: Record<string, unknown>;
}

export interface GatePolicyInput {
  allowedTools: { name: string; risk: "low" | "medium" | "high" }[];
  workspaceDir: string;
  /** high-risk tools require this flag granted by goal contract / user */
  highRiskAuthorized?: boolean;
  /** max accepted args size; guards context flooding */
  maxArgsBytes?: number;
}

export interface GateDecision {
  allowed: boolean;
  reason: string;
  /** normalized arg overrides (e.g. absolute paths resolved inside sandbox) */
  normalizedArgs?: Record<string, unknown>;
}

const BUILTIN_CONSTRAINTS: Record<string, (args: Record<string, unknown>, input: GatePolicyInput) => GateDecision> = {
  // workspace tools: all paths must resolve INSIDE the sandbox workspace
  workspace_write: pathConstraint("path"),
  workspace_read: pathConstraint("path"),
  workspace_list: pathConstraint("path", true),
  run_python: (args, input) => {
    if (typeof args.script !== "string") return deny("run_python requires script string");
    if ((args.script as string).length > 200_000) return deny("script too large");
    return { allowed: true, reason: "ok" };
  },
};

function pathConstraint(field: string, optional = false) {
  return (args: Record<string, unknown>, input: GatePolicyInput): GateDecision => {
    const raw = args[field];
    if (raw === undefined && optional) return { allowed: true, reason: "ok" };
    if (typeof raw !== "string") return deny(`${field} must be a string`);
    const resolved = path.resolve(input.workspaceDir, raw);
    const normWorkspace = path.resolve(input.workspaceDir);
    if (resolved !== normWorkspace && !resolved.startsWith(normWorkspace + path.sep)) {
      return deny(`path escapes sandbox workspace: ${raw}`);
    }
    const normalized = { ...args, [field]: resolved };
    return { allowed: true, reason: "ok", normalizedArgs: normalized };
  };
}

function deny(reason: string): GateDecision {
  return { allowed: false, reason };
}

export function evaluateToolCall(req: ToolCallRequest, input: GatePolicyInput): GateDecision {
  const tool = input.allowedTools.find((t) => t.name === req.tool);
  if (!tool) {
    return deny(`tool "${req.tool}" is not in the authorized tool set for this attempt`);
  }
  if (tool.risk === "high" && !input.highRiskAuthorized) {
    return deny(`tool "${req.tool}" is high-risk and not authorized by the goal contract`);
  }
  if (input.maxArgsBytes && JSON.stringify(req.args ?? {}).length > input.maxArgsBytes) {
    return deny("tool arguments exceed size limit");
  }
  const constraint = BUILTIN_CONSTRAINTS[req.tool];
  if (constraint) return constraint(req.args ?? {}, input);
  return { allowed: true, reason: "ok" };
}
