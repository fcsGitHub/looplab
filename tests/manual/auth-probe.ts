import { createTestEnv } from "../helpers/spawn-control.js";

const env = await createTestEnv();
const reg = await env.inject({ method: "POST", url: "/v1/auth/register", payload: { username: "t", password: "looplab" } });
console.log("register:", reg.statusCode, reg.body.slice(0, 120));
console.log("cookies:", JSON.stringify(reg.cookies));
const cookie = reg.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const me = await env.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
console.log("me:", me.statusCode, me.body.slice(0, 200));
await env.close();
