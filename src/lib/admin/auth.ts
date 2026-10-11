import type { Db } from "../db/client";
import { hashToken, newSessionToken, verifyPassword, verifyTotp } from "./crypto";

export const SESSION_HOURS = 12;
export const MAX_FAILED = 5;
export const LOCKOUT_MINUTES = 15;

export type LoginResult =
  | { ok: true; token: string; userId: string; expiresAt: Date }
  | { ok: false; reason: "locked" | "invalid" };

/**
 * Single-admin login: password and a current authenticator code, both required.
 * After MAX_FAILED failures inside LOCKOUT_MINUTES, all logins are refused
 * until the window passes. Errors never say which factor was wrong.
 */
export async function login(db: Db, password: string, code: string, nowMs = Date.now()): Promise<LoginResult> {
  const { rows: fails } = await db.query<{ n: number }>(
    `select count(*)::int as n from app.admin_login_attempts
      where not succeeded and at > now() - make_interval(mins => $1)`, [LOCKOUT_MINUTES]);
  if (fails[0].n >= MAX_FAILED) return { ok: false, reason: "locked" };

  const { rows } = await db.query<{ user_id: string; password_hash: string; totp_secret: string; totp_last_counter: string }>(
    `select user_id, password_hash, totp_secret, totp_last_counter from app.admin_credentials limit 1`);
  const cred = rows[0];

  let counter: number | null = null;
  if (cred && (await verifyPassword(password, cred.password_hash))) {
    counter = verifyTotp(cred.totp_secret, code.trim(), Number(cred.totp_last_counter), nowMs);
  }

  if (!cred || counter === null) {
    await db.query(`insert into app.admin_login_attempts (succeeded) values (false)`);
    await db.query(`insert into app.audit_events (actor, action) values ('anonymous', 'admin.login_failed')`);
    return { ok: false, reason: "invalid" };
  }

  const token = newSessionToken();
  const expiresAt = new Date(nowMs + SESSION_HOURS * 3600_000);
  await db.transaction(async (tx) => {
    // Recording the used time step makes the same code unusable a second time.
    await tx.query(`update app.admin_credentials set totp_last_counter = $2 where user_id = $1`, [cred.user_id, counter]);
    await tx.query(`insert into app.admin_sessions (token_hash, user_id, expires_at) values ($1, $2, $3)`,
      [hashToken(token), cred.user_id, expiresAt.toISOString()]);
    await tx.query(`insert into app.admin_login_attempts (succeeded) values (true)`);
    await tx.query(`insert into app.audit_events (actor, action) values ($1, 'admin.login')`, [`admin:${cred.user_id}`]);
  });
  return { ok: true, token, userId: cred.user_id, expiresAt };
}

/** Returns the admin's user id for a live session, or null. */
export async function sessionUser(db: Db, token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const { rows } = await db.query<{ user_id: string }>(
    `select s.user_id from app.admin_sessions s
       join app.admin_credentials c on c.user_id = s.user_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()`,
    [hashToken(token)]);
  return rows[0]?.user_id ?? null;
}

export async function logout(db: Db, token: string | undefined): Promise<void> {
  if (!token) return;
  const { rows } = await db.query<{ user_id: string }>(
    `update app.admin_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null returning user_id`,
    [hashToken(token)]);
  if (rows[0]) {
    await db.query(`insert into app.audit_events (actor, action) values ($1, 'admin.logout')`, [`admin:${rows[0].user_id}`]);
  }
}
