// HTTP client for the control service (worker side). No DB access, no secrets.
export class ControlClient {
  constructor(private baseUrl: string) {}

  private async req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return { status: 204, json: null };
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, json };
  }

  claim(workerId: string) {
    return this.req("POST", "/v1/worker/claim", { worker_id: workerId });
  }
  start(attemptId: string, workerId: string, leaseEpoch: number) {
    return this.req("POST", `/v1/attempts/${attemptId}/start`, { worker_id: workerId, lease_epoch: leaseEpoch });
  }
  heartbeat(attemptId: string, workerId: string, leaseEpoch: number) {
    return this.req("POST", `/v1/attempts/${attemptId}/heartbeat`, { worker_id: workerId, lease_epoch: leaseEpoch });
  }
  llm(attemptId: string, workerId: string, leaseEpoch: number, payload: {
    messages: unknown[]; tools?: unknown[]; max_tokens?: number; temperature?: number; idempotency_key?: string;
  }) {
    return this.req("POST", `/v1/attempts/${attemptId}/llm`, {
      worker_id: workerId, lease_epoch: leaseEpoch, ...payload,
    });
  }
  authorizeTool(attemptId: string, workerId: string, leaseEpoch: number, tool: string, args: Record<string, unknown>) {
    return this.req("POST", `/v1/attempts/${attemptId}/tools/authorize`, {
      worker_id: workerId, lease_epoch: leaseEpoch, tool, args,
    });
  }
  reportTool(attemptId: string, workerId: string, leaseEpoch: number, payload: {
    tool: string; ok: boolean; output_digest: string; output_bytes: number; duration_ms: number;
  }) {
    return this.req("POST", `/v1/attempts/${attemptId}/tools/report`, {
      worker_id: workerId, lease_epoch: leaseEpoch, ...payload,
    });
  }
  confirmSteer(attemptId: string, steerId: string, workerId: string, leaseEpoch: number) {
    return this.req("POST", `/v1/attempts/${attemptId}/steers/${steerId}/delivered`, {
      worker_id: workerId, lease_epoch: leaseEpoch,
    });
  }
  checkpoint(attemptId: string, workerId: string, leaseEpoch: number, payload: {
    step_index: number; summary: string; state: Record<string, unknown>;
    artifact_refs?: string[]; progress_kind: string;
  }) {
    return this.req("POST", `/v1/attempts/${attemptId}/checkpoint`, {
      worker_id: workerId, lease_epoch: leaseEpoch, ...payload,
    });
  }
  uploadArtifact(attemptId: string, goalId: string, name: string, mediaType: string, body: Buffer): Promise<{ status: number; json: any }> {
    return fetch(`${this.baseUrl}/v1/artifacts`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(body.byteLength),
        "x-artifact-name": encodeURIComponent(name),
        "x-artifact-media-type": mediaType,
        "x-attempt-id": attemptId,
        "x-producer-role": "worker",
        "x-goal-id": goalId,
        "x-scope": "task",
      },
      body: new Uint8Array(body),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  }
  async downloadPropagated(attemptId: string, workerId: string, leaseEpoch: number, digest: string): Promise<Buffer | null> {
    const res = await fetch(
      `${this.baseUrl}/v1/attempts/${attemptId}/propagated/${digest}?worker_id=${encodeURIComponent(workerId)}&lease_epoch=${leaseEpoch}`,
    );
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }
  commit(attemptId: string, workerId: string, payload: Record<string, unknown>) {
    return this.req("POST", `/v1/attempts/${attemptId}/commit`, { worker_id: workerId, ...payload });
  }
}
