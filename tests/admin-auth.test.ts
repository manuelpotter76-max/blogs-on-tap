import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase } from "./helpers/psql-db";
import { hashPassword, verifyPassword, totpCode, verifyTotp, newTotpSecret, currentCounter } from "../src/lib/admin/crypto";
import { login, sessionUser, logout, MAX_FAILED } from "../src/lib/admin/auth";

// RFC 6238 test secret "12345678901234567890" in base32.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("TOTP matches the RFC 6238 SHA-1 test vectors", () => {
  // RFC values are 8 digits; the 6-digit code is the last 6.
  assert.equal(totpCode(RFC_SECRET, Math.floor(59 / 30)), "287082");
  assert.equal(totpCode(RFC_SECRET, Math.floor(1111111109 / 30)), "081804");
  assert.equal(totpCode(RFC_SECRET, Math.floor(1234567890 / 30)), "005924");
  assert.equal(totpCode(RFC_SECRET, Math.floor(2000000000 / 30)), "279037");
});

test("TOTP accepts ±30s drift, rejects older codes and replays", () => {
  const now = 1_800_000_000_000;
  const c = currentCounter(now);
  assert.equal(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, c), 0, now), c);
  assert.equal(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, c - 1), 0, now), c - 1);
  assert.equal(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, c - 2), 0, now), null, "too old");
  assert.equal(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, c), c, now), null, "already used");
  assert.equal(verifyTotp(RFC_SECRET, "12345", 0, now), null, "wrong length");
});

test("new TOTP secrets are 32 base32 characters", () => {
  const s = newTotpSecret();
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.match(totpCode(s, 1), /^\d{6}$/);
});

test("passwords hash with a salt and verify", async () => {
  const h1 = await hashPassword("correct horse");
  const h2 = await hashPassword("correct horse");
  assert.notEqual(h1, h2, "salted");
  assert.equal(await verifyPassword("correct horse", h1), true);
  assert.equal(await verifyPassword("wrong horse", h1), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
});

// ---------------------------------------------------------------------------
const db = freshDatabase("bot_admin_test");
after(() => db.close());
const NOW = 1_800_000_000_000;
let adminId = "";

test("setup: one admin with password and TOTP", async () => {
  const { rows } = await db.query<{ id: string }>(
    `insert into app.users (email, full_name) values ('admin@test', 'Admin') returning id`);
  adminId = rows[0].id;
  await db.query(`insert into app.admin_credentials (user_id, password_hash, totp_secret) values ($1, $2, $3)`,
    [adminId, await hashPassword("S3cret-pass"), RFC_SECRET]);
});

test("login needs both the right password and a current code", async () => {
  const code = totpCode(RFC_SECRET, currentCounter(NOW));
  assert.deepEqual(await login(db, "wrong", code, NOW), { ok: false, reason: "invalid" });
  assert.deepEqual(await login(db, "S3cret-pass", "000000", NOW), { ok: false, reason: "invalid" });

  const ok = await login(db, "S3cret-pass", code, NOW);
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(await sessionUser(db, ok.token), adminId);
  assert.equal(await sessionUser(db, ok.token + "x"), null, "tampered token");
  assert.equal(await sessionUser(db, undefined), null);

  // The same code cannot be used twice.
  assert.deepEqual(await login(db, "S3cret-pass", code, NOW), { ok: false, reason: "invalid" });

  await logout(db, ok.token);
  assert.equal(await sessionUser(db, ok.token), null, "logged out");
});

test("only token hashes are stored, never tokens", async () => {
  const { rows } = await db.query<{ token_hash: string }>(`select token_hash from app.admin_sessions`);
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)));
});

test(`locks out after ${MAX_FAILED} failures, even with correct details`, async () => {
  // Three failures so far; two more reach the limit.
  await login(db, "nope", "111111", NOW);
  await login(db, "nope", "111111", NOW);
  const later = NOW + 60_000;
  const res = await login(db, "S3cret-pass", totpCode(RFC_SECRET, currentCounter(later)), later);
  assert.deepEqual(res, { ok: false, reason: "locked" });
});

test("failures and logins are audited", async () => {
  const { rows } = await db.query<{ action: string; n: number }>(
    `select action, count(*)::int as n from app.audit_events group by action order by action`);
  const map = Object.fromEntries(rows.map((r) => [r.action, r.n]));
  assert.equal(map["admin.login"], 1);
  assert.equal(map["admin.logout"], 1);
  assert.equal(map["admin.login_failed"], 5);
});
