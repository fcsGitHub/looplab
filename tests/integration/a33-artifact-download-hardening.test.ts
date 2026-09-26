// A33 (P24, V19): stored-XSS hardening on artifact download. Artifacts are
// untrusted worker/model output and the workbench opens them in a new tab on
// the API origin — the same origin that carries the session cookie. A
// text/html or SVG artifact used to be served with its uploaded media type,
// so opening it executed attacker markup with the viewer's session (httpOnly
// blocks cookie theft, not same-origin fetch riding the session). Downloads
// now force attachment + nosniff and neutralize scriptable media types.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, authedUser, type TestEnv } from "../helpers/spawn-control.js";

let env: TestEnv;
let user: Awaited<ReturnType<typeof authedUser>>;

beforeAll(async () => {
  env = await createTestEnv({});
  user = await authedUser(env, "a33-viewer");
});
afterAll(async () => { await env.close(); });

async function upload(name: string, mediaType: string, body: string): Promise<string> {
  const res = await env.inject({
    method: "POST", url: "/v1/artifacts",
    headers: {
      "content-type": "application/octet-stream",
      "x-artifact-name": encodeURIComponent(name),
      "x-artifact-media-type": mediaType,
      "x-scope": "global",
    },
    payload: Buffer.from(body, "utf8"),
  });
  expect(res.statusCode).toBe(200);
  const json = res.json();
  return json.digest as string;
}

describe("A33 artifact download hardening", () => {
  it("never serves text/html as renderable — opaque download instead", async () => {
    const digest = await upload("report.html", "text/html",
      "<html><script>fetch('/v1/goals',{credentials:'include'})</script></html>");
    const res = await user.get(`/v1/artifacts/${digest}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    // bytes themselves stay intact (content addressing is the integrity rule)
    expect(res.body).toContain("<script>");
  });

  it("neutralizes SVG too (SVG is scriptable)", async () => {
    const digest = await upload("chart.svg", "image/svg+xml",
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    const res = await user.get(`/v1/artifacts/${digest}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toContain("attachment");
  });

  it("keeps benign media types but still forces attachment + nosniff", async () => {
    const digest = await upload("notes.md", "text/markdown", "# ok\n");
    const res = await user.get(`/v1/artifacts/${digest}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/markdown");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sanitizes the download filename (no traversal, quotes or control chars)", async () => {
    const digest = await upload('../../evil"<script>.html', "text/html", "x");
    const res = await user.get(`/v1/artifacts/${digest}`);
    expect(res.statusCode).toBe(200);
    const cd = String(res.headers["content-disposition"]);
    expect(cd).toContain("attachment");
    const fname = cd.match(/filename="([^"]*)"/)?.[1] ?? "";
    expect(fname).not.toContain("..");
    expect(fname).not.toMatch(/[<>"\\]/);
    // the readable part survives (extension kept for the user)
    expect(fname).toContain(".html");
  });
});
