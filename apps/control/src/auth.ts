// Auth: local accounts + httpOnly session cookies. scrypt from node:crypto —
// no native deps. First registered user becomes admin.
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db.js";

export const SESSION_COOKIE = "ll_session";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = parts[1]!;
  const hash = parts[2]!;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export class AuthService {
  constructor(private db: Db, private sessionTtlMs: number) {}

  async register(username: string, password: string): Promise<{ id: string; role: string }> {
    const count = await this.db.query("SELECT count(*)::int AS n FROM users");
    const role = Number(count.rows[0]?.n ?? 0) === 0 ? "admin" : "member";
    const id = `usr_${randomBytes(8).toString("hex")}`;
    await this.db.query(
      "INSERT INTO users (id, username, password_hash, role) VALUES ($1,$2,$3,$4)",
      [id, username, hashPassword(password), role],
    );
    return { id, role };
  }

  async login(username: string, password: string): Promise<{ token: string; userId: string } | null> {
    const res = await this.db.query("SELECT id, password_hash FROM users WHERE username=$1", [username]);
    const user = res.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) return null;
    const token = randomBytes(32).toString("hex");
    const id = `ses_${randomBytes(8).toString("hex")}`;
    await this.db.query(
      "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)",
      [id, user.id, tokenHash(token), new Date(Date.now() + this.sessionTtlMs)],
    );
    return { token, userId: user.id };
  }

  async logout(token: string): Promise<void> {
    await this.db.query("UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1", [tokenHash(token)]);
  }

  async userFromRequest(req: FastifyRequest): Promise<{ id: string; username: string; role: string } | null> {
    const token = (req.cookies?.[SESSION_COOKIE] as string) || bearer(req);
    if (!token) return null;
    const res = await this.db.query(
      `SELECT u.id, u.username, u.role FROM auth_sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [tokenHash(token)],
    );
    return (res.rows[0] as { id: string; username: string; role: string } | undefined) ?? null;
  }

  setCookie(reply: FastifyReply, token: string) {
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(this.sessionTtlMs / 1000),
    });
  }
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  return null;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: { id: string; username: string; role: string } | null;
  }
}
