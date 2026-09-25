// Minimal environment for spawned infrastructure children (evaluator,
// candidate_runner, optimizer backends, research runner). The control process
// may legitimately hold secrets (DEEPSEEK_API_KEY via an exported env or the
// gitignored .env.local loader); a `...process.env` spread silently forwards
// them to every child (P19 fix: allowlist, not blacklist). Sandbox children
// keep the same shape — nothing here is secret.
export function infraEnv(extra: Record<string, string> = {}): Record<string, string> {
  const pick = (name: string, fallback?: string): string => {
    const v = process.env[name] ?? fallback;
    return v === undefined ? "" : v;
  };
  return {
    PATH: pick("PATH"),
    SYSTEMROOT: pick("SYSTEMROOT", "C:\\Windows"),
    COMSPEC: pick("COMSPEC", "cmd.exe"),
    TEMP: pick("TEMP", "C:\\Temp"),
    TMP: pick("TMP", "C:\\Temp"),
    PYTHONIOENCODING: "utf-8",
    PYTHONDONTWRITEBYTECODE: "1",
    ...extra,
  };
}
