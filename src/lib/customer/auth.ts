import { createHash, randomBytes } from "node:crypto";
import type { Db, Queryable } from "../db/client";
import { hashPassword, verifyPassword, hashToken, newSessionToken } from "../admin/crypto";
import { sendEmail } from "../email/send";
import { accountSetup, passwordChanged, passwordReset, signInLink, teammateInvite } from "../email/templates";

/**
 * Customer sign-in. Email is the username. A person (app.users) can belong to
 * several businesses (app.memberships); a session is for one person in one
 * business at a time.
 *
 * Login links (setup, sign-in, reset, invite) are random tokens; only their
 * SHA-256 is stored. Opening a link page never uses it up (mail scanners
 * pre-open links); submitting the page does, exactly once.
 */

export const SESSION_DAYS = 30;
export const MIN_PASSWORD = 10;
export const MAX_TEAMMATES = 5;

export type LinkPurpose = "account_setup" | "sign_in" | "password_reset" | "invite";
const LINK_MINUTES: Record<LinkPurpose, number> = {
  account_setup: 7 * 24 * 60,
  sign_in: 15,
  password_reset: 60,
  invite: 7 * 24 * 60,
};

// Throttling windows (see the plan: 5 per email, 20 per network, 15 minutes).
const WINDOW_MIN = 15;
const MAX_FAILS_PER_EMAIL = 5;
const MAX_FAILS_PER_IP = 20;
const MAX_LINKS_PER_EMAIL = 3;

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i;

// A small list of the passwords people pick most. Long enough to stop the
// obvious ones; the 10-character minimum does most of the work.
const COMMON = new Set([
  "1234567890", "12345678910", "0123456789", "1111111111", "0000000000", "qwertyuiop", "password1", "password12",
  "password123", "password1234", "passw0rd123", "iloveyou12", "abc1234567", "qwerty1234", "qwerty12345",
  "1q2w3e4r5t", "1qaz2wsx3edc", "asdfghjkl1", "letmein123", "welcome123", "welcome1234", "admin12345",
  "football123", "baseball123", "sunshine123", "princess123", "dragon1234", "monkey1234", "starwars123",
  "changeme123", "trustno1234", "superman123", "blogsontap", "blogsontap1", "blogsontap123", "tampabay123",
  "yborcity123", "aaaaaaaaaa", "abcdefghij", "abcdefghijk",
]);

export function normalizeEmail(s: string): string {
  return String(s ?? "").trim().toLowerCase();
}

export function validEmail(s: string): boolean {
  const e = normalizeEmail(s);
  return e.length <= 254 && EMAIL.test(e);
}

/** Why a new password isn't acceptable, in plain words, or null if it's fine. */
export function passwordProblem(password: string, email: string): string | null {
  const p = String(password ?? "");
  if (p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (p.length > 200) return "That's too long. Keep it under 200 characters.";
  const lower = p.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(p)) return "That one is too common. Try a short phrase you'll remember.";
  const local = normalizeEmail(email).split("@")[0];
  if (local.length >= 4 && lower.includes(local)) return "Don't use your email address in your password.";
  return null;
}

export function ipHash(ip: string | null | undefined): string | null {
  const v = String(ip ?? "").split(",")[0].trim();
  if (!v) return null;
  return createHash("sha256").update(`${v}:${process.env.LINK_SECRET ?? ""}`).digest("hex").slice(0, 32);
}

function baseUrl(): string {
  const base = (process.env.APP_BASE_URL ?? "").trim().replace(/\/$/, "");
  if (!base) throw new Error("APP_BASE_URL must be set");
  return base;
}

/** Only same-site paths are allowed as a post-sign-in destination. */
export function safeNext(next: unknown): string {
  const n = String(next ?? "");
  return n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") && n.length < 300 ? n : "/dashboard";
}

async function audit(db: Queryable, orgId: string | null, actor: string, action: string, details: object = {}) {
  await db.query(
    `insert into app.audit_events (org_id, actor, action, target, details) values ($1, $2, $3, $4, $5)`,
    [orgId, actor, action, orgId, JSON.stringify(details)]);
}

// ---------------------------------------------------------------------------
// People and businesses
// ---------------------------------------------------------------------------
type UserRow = { id: string; email: string; full_name: string | null; password_hash: string | null; login_ready_at: string | null };

async function userByEmail(db: Queryable, email: string): Promise<UserRow | undefined> {
  return (await db.query<UserRow>(
    `select id, email, full_name, password_hash, login_ready_at from app.users where lower(email) = $1`,
    [normalizeEmail(email)])).rows[0];
}

/** The business a person lands in: their most recent active membership in an active business. */
export async function defaultOrg(db: Queryable, userId: string): Promise<string | null> {
  const { rows } = await db.query<{ org_id: string }>(
    `select m.org_id from app.memberships m join app.organizations o on o.id = m.org_id
      where m.user_id = $1 and m.status = 'active' and o.status = 'active'
      order by m.created_at desc limit 1`, [userId]);
  return rows[0]?.org_id ?? null;
}

export async function orgsFor(db: Queryable, userId: string): Promise<{ org_id: string; name: string; role: string }[]> {
  return (await db.query<{ org_id: string; name: string; role: string }>(
    `select m.org_id, o.name, m.role from app.memberships m join app.organizations o on o.id = m.org_id
      where m.user_id = $1 and m.status = 'active' and o.status = 'active' order by lower(o.name)`, [userId])).rows;
}

/** The owner of a business (the person Zoho signed up), if there is one. */
export async function ownerOf(db: Queryable, orgId: string): Promise<UserRow | undefined> {
  return (await db.query<UserRow>(
    `select u.id, u.email, u.full_name, u.password_hash, u.login_ready_at
       from app.memberships m join app.users u on u.id = m.user_id
      where m.org_id = $1 and m.status = 'active'
      order by (m.role = 'owner') desc, m.created_at limit 1`, [orgId])).rows[0];
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
export type CustomerSession = {
  userId: string; orgId: string; email: string; fullName: string | null; role: "owner" | "member";
  orgName: string; hasPassword: boolean; expiresAt: string;
};

export async function createSession(db: Queryable, userId: string, orgId: string, userAgent?: string | null): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5);
  await db.query(
    `insert into app.customer_sessions (token_hash, user_id, org_id, expires_at, user_agent) values ($1, $2, $3, $4, $5)`,
    [hashToken(token), userId, orgId, expiresAt.toISOString(), (userAgent ?? "").slice(0, 200) || null]);
  await db.query(`update app.users set last_sign_in_at = now() where id = $1`, [userId]);
  return { token, expiresAt };
}

/**
 * The signed-in person, or null. A session dies if it's expired or signed out,
 * or if the person is no longer an active member of that business. Sessions
 * in use are extended (at most once a day, to keep writes low).
 */
export async function sessionFor(db: Queryable, token: string | null | undefined): Promise<CustomerSession | null> {
  if (!token || token.length > 100) return null;
  const { rows } = await db.query<CustomerSession & { last_seen_at: string }>(
    `select s.user_id as "userId", s.org_id as "orgId", u.email, u.full_name as "fullName", m.role,
            o.name as "orgName", (u.password_hash is not null) as "hasPassword", s.expires_at as "expiresAt", s.last_seen_at
       from app.customer_sessions s
       join app.users u on u.id = s.user_id
       join app.memberships m on m.user_id = s.user_id and m.org_id = s.org_id and m.status = 'active'
       join app.organizations o on o.id = s.org_id and o.status = 'active'
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()`, [hashToken(token)]);
  const s = rows[0];
  if (!s) return null;
  if (Date.now() - Date.parse(s.last_seen_at) > 864e5) {
    await db.query(
      `update app.customer_sessions set last_seen_at = now(), expires_at = now() + make_interval(days => $2)
        where token_hash = $1`, [hashToken(token), SESSION_DAYS]);
  }
  const { last_seen_at: _ignored, ...out } = s;
  return out;
}

export async function endSession(db: Queryable, token: string | null | undefined) {
  if (!token) return;
  await db.query(`update app.customer_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null`,
    [hashToken(token)]);
}

/** Sign out everywhere (optionally keeping the session in use right now). */
export async function endAllSessions(db: Queryable, userId: string, keepToken?: string | null) {
  await db.query(
    `update app.customer_sessions set revoked_at = now()
      where user_id = $1 and revoked_at is null and ($2::text is null or token_hash <> $2::text)`,
    [userId, keepToken ? hashToken(keepToken) : null]);
}

/** Move a session to another business the person belongs to. */
export async function switchOrg(db: Queryable, token: string, userId: string, orgId: string): Promise<boolean> {
  const ok = (await orgsFor(db, userId)).some((o) => o.org_id === orgId);
  if (!ok) return false;
  await db.query(`update app.customer_sessions set org_id = $2 where token_hash = $1 and user_id = $3`,
    [hashToken(token), orgId, userId]);
  return true;
}

// ---------------------------------------------------------------------------
// Password sign-in, with throttling
// ---------------------------------------------------------------------------
async function throttled(db: Queryable, email: string, ip: string | null): Promise<boolean> {
  const { rows } = await db.query<{ by_email: number; by_ip: number }>(
    `select count(*) filter (where email = $1)::int as by_email,
            count(*) filter (where $2::text is not null and ip_hash = $2::text)::int as by_ip
       from app.customer_login_attempts
      where not succeeded and at > now() - make_interval(mins => $3)
        and (email = $1 or ($2::text is not null and ip_hash = $2::text))`, [email, ip, WINDOW_MIN]);
  return rows[0].by_email >= MAX_FAILS_PER_EMAIL || rows[0].by_ip >= MAX_FAILS_PER_IP;
}

// A real hash to check against when the email has no password, so a missing
// account takes as long to reject as a wrong password.
let dummyHash: Promise<string> | undefined;

export type SignInResult =
  | { ok: true; token: string; expiresAt: Date; userId: string; orgId: string }
  | { ok: false; reason: "invalid" | "throttled" | "no_business" };

export async function signInWithPassword(
  db: Queryable, emailIn: string, password: string, ip: string | null, userAgent?: string | null,
): Promise<SignInResult> {
  const email = normalizeEmail(emailIn);
  if (!validEmail(email) || !password) return { ok: false, reason: "invalid" };
  if (await throttled(db, email, ip)) return { ok: false, reason: "throttled" };

  const user = await userByEmail(db, email);
  dummyHash ??= hashPassword("not-a-real-password-0000");
  const good = await verifyPassword(password, user?.password_hash ?? await dummyHash) && Boolean(user?.password_hash);
  await db.query(`insert into app.customer_login_attempts (email, ip_hash, succeeded) values ($1, $2, $3)`,
    [email, ip, good]);
  if (!good || !user) return { ok: false, reason: "invalid" };

  const orgId = await defaultOrg(db, user.id);
  if (!orgId) return { ok: false, reason: "no_business" };
  const s = await createSession(db, user.id, orgId, userAgent);
  return { ok: true, ...s, userId: user.id, orgId };
}

/** Set (or change) a password. Signs out every other device. */
export async function setPassword(db: Queryable, userId: string, password: string, keepToken?: string | null) {
  await db.query(
    `update app.users set password_hash = $2, password_changed_at = now(), login_ready_at = coalesce(login_ready_at, now())
      where id = $1`, [userId, await hashPassword(password)]);
  await endAllSessions(db, userId, keepToken);
}

export async function checkPassword(db: Queryable, userId: string, password: string): Promise<boolean> {
  const u = (await db.query<{ password_hash: string | null }>(`select password_hash from app.users where id = $1`, [userId])).rows[0];
  return Boolean(u?.password_hash) && await verifyPassword(password, u!.password_hash!);
}

// ---------------------------------------------------------------------------
// Login links
// ---------------------------------------------------------------------------
export function loginLinkUrl(token: string): string {
  return `${baseUrl()}/login/l/${token}`;
}

/** A new single-use link. Any older unused link of the same kind for this person and business stops working. */
export async function createLoginLink(db: Queryable, userId: string, orgId: string, purpose: LinkPurpose): Promise<{ id: string; token: string; url: string }> {
  await db.query(
    `update app.login_links set used_at = now()
      where user_id = $1 and org_id = $2 and purpose = $3 and used_at is null`, [userId, orgId, purpose]);
  const token = randomBytes(32).toString("base64url");
  const { rows } = await db.query<{ id: string }>(
    `insert into app.login_links (token_hash, user_id, org_id, purpose, expires_at)
     values ($1, $2, $3, $4, now() + make_interval(mins => $5)) returning id`,
    [hashToken(token), userId, orgId, purpose, LINK_MINUTES[purpose]]);
  return { id: rows[0].id, token, url: loginLinkUrl(token) };
}

export type LoginLink = {
  id: string; purpose: LinkPurpose; userId: string; orgId: string; email: string; fullName: string | null;
  orgName: string; hasPassword: boolean; inviter: string | null;
};

const LINK_SQL = `
  select l.id, l.purpose, l.user_id as "userId", l.org_id as "orgId", u.email, u.full_name as "fullName",
         o.name as "orgName", (u.password_hash is not null) as "hasPassword",
         (select coalesce(nullif(iu.full_name, ''), iu.email) from app.memberships m join app.users iu on iu.id = m.invited_by
           where m.org_id = l.org_id and m.user_id = l.user_id) as inviter
    from app.login_links l
    join app.users u on u.id = l.user_id
    join app.organizations o on o.id = l.org_id and o.status = 'active'
   where l.token_hash = $1 and l.used_at is null and l.expires_at > now()`;

/** Look at a link without using it (for showing the page). */
export async function peekLoginLink(db: Queryable, token: string): Promise<LoginLink | null> {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(String(token ?? ""))) return null;
  return (await db.query<LoginLink>(LINK_SQL, [hashToken(token)])).rows[0] ?? null;
}

/** Use a link up. Returns it only the first time, and only if it's one of the expected kinds. */
export async function useLoginLink(db: Queryable, token: string, purposes: LinkPurpose[]): Promise<LoginLink | null> {
  const link = await peekLoginLink(db, token);
  if (!link || !purposes.includes(link.purpose)) return null;
  const { rows } = await db.query<{ id: string }>(
    `update app.login_links set used_at = now() where id = $1 and used_at is null and expires_at > now() returning id`,
    [link.id]);
  return rows[0] ? link : null;
}

async function recentLinks(db: Queryable, userId: string): Promise<number> {
  return (await db.query<{ n: number }>(
    `select count(*)::int as n from app.login_links
      where user_id = $1 and purpose in ('sign_in', 'password_reset') and created_at > now() - make_interval(mins => $2)`,
    [userId, WINDOW_MIN])).rows[0].n;
}

/**
 * "Email me a sign-in link" and "Forgot password". The caller always shows the
 * same message, so nobody can tell from the page which emails are customers.
 */
export async function requestEmailLink(db: Queryable, emailIn: string, purpose: "sign_in" | "password_reset"): Promise<"sent" | "skipped"> {
  const email = normalizeEmail(emailIn);
  if (!validEmail(email)) return "skipped";
  const user = await userByEmail(db, email);
  if (!user) return "skipped";
  const orgId = await defaultOrg(db, user.id);
  if (!orgId) return "skipped";
  if (await recentLinks(db, user.id) >= MAX_LINKS_PER_EMAIL) return "skipped";
  const link = await createLoginLink(db, user.id, orgId, purpose);
  const mail = purpose === "sign_in" ? signInLink(link.url) : passwordReset(link.url);
  try {
    await sendEmail(db, { orgId, kind: `login_${purpose}`, dedupeKey: `login:${link.id}`, to: user.email, ...mail });
  } catch (err) {
    // The page says the same thing either way (so it can't be used to find accounts);
    // the failure is recorded on the notification and shows in admin.
    console.error(`login email (${purpose}) failed:`, (err as Error).message);
    return "skipped";
  }
  return "sent";
}

/** Admin button: email the owner a link to set up their login. */
export async function sendAccountSetup(db: Queryable, adminId: string, orgId: string): Promise<"sent" | "no_owner" | "already_set" | "email_failed"> {
  const owner = await ownerOf(db, orgId);
  if (!owner) return "no_owner";
  if (owner.login_ready_at) return "already_set";
  const org = (await db.query<{ name: string }>(`select name from app.organizations where id = $1`, [orgId])).rows[0];
  const link = await createLoginLink(db, owner.id, orgId, "account_setup");
  try {
    await sendEmail(db, { orgId, kind: "login_account_setup", dedupeKey: `login:${link.id}`, to: owner.email,
      ...accountSetup(org.name, link.url) });
  } catch (err) {
    console.error("login setup email failed:", (err as Error).message);
    await db.query(`update app.login_links set used_at = now() where id = $1`, [link.id]);
    return "email_failed";
  }
  await audit(db, orgId, `admin:${adminId}`, "login.setup_sent", { to: owner.email });
  return "sent";
}

export async function notifyPasswordChanged(db: Queryable, userId: string, orgId: string) {
  const u = (await db.query<{ email: string }>(`select email from app.users where id = $1`, [userId])).rows[0];
  try {
    await sendEmail(db, { orgId, kind: "login_password_changed", dedupeKey: `pwchanged:${userId}:${Date.now()}`,
      to: u.email, ...passwordChanged(`${baseUrl()}/dashboard`) });
  } catch (err) {
    // A heads-up email failing must never undo or block the password change.
    console.error("password changed email failed:", (err as Error).message);
  }
}

/**
 * Finish a setup, reset or invite link: set the password, use the link, and
 * sign in. Invites also become active memberships. Returns a session token.
 */
export async function completeLinkWithPassword(
  db: Db, token: string, password: string, userAgent?: string | null,
): Promise<{ ok: true; token: string; expiresAt: Date } | { ok: false; reason: "bad_link" | "bad_password"; message?: string }> {
  const peek = await peekLoginLink(db, token);
  if (!peek || !["account_setup", "password_reset", "invite"].includes(peek.purpose)) return { ok: false, reason: "bad_link" };
  const problem = passwordProblem(password, peek.email);
  if (problem) return { ok: false, reason: "bad_password", message: problem };
  const hash = await hashPassword(password);
  const out = await db.transaction(async (tx) => {
    const link = await useLoginLink(tx, token, ["account_setup", "password_reset", "invite"]);
    if (!link) return null;
    await tx.query(
      `update app.users set password_hash = $2, password_changed_at = now(), login_ready_at = coalesce(login_ready_at, now())
        where id = $1`, [link.userId, hash]);
    await endAllSessions(tx, link.userId);
    if (link.purpose === "invite") {
      await tx.query(`update app.memberships set status = 'active' where org_id = $1 and user_id = $2`, [link.orgId, link.userId]);
    }
    await audit(tx, link.orgId, `customer:${link.userId}`,
      link.purpose === "password_reset" ? "login.password_reset" : link.purpose === "invite" ? "login.invite_accepted" : "login.set_up");
    const s = await createSession(tx, link.userId, link.orgId, userAgent);
    return { link, s };
  });
  if (!out) return { ok: false, reason: "bad_link" };
  if (out.link.purpose === "password_reset") await notifyPasswordChanged(db, out.link.userId, out.link.orgId);
  return { ok: true, token: out.s.token, expiresAt: out.s.expiresAt };
}

/** Finish a sign-in link, or an invite for someone who already has a password. */
export async function completeLinkSignIn(db: Db, token: string, userAgent?: string | null): Promise<{ token: string; expiresAt: Date } | null> {
  return db.transaction(async (tx) => {
    const peek = await peekLoginLink(tx, token);
    if (!peek) return null;
    const allowed: LinkPurpose[] = peek.purpose === "invite" && peek.hasPassword ? ["invite"] : ["sign_in"];
    const link = await useLoginLink(tx, token, allowed);
    if (!link) return null;
    if (link.purpose === "invite") {
      await tx.query(`update app.memberships set status = 'active' where org_id = $1 and user_id = $2`, [link.orgId, link.userId]);
      await audit(tx, link.orgId, `customer:${link.userId}`, "login.invite_accepted");
    }
    return createSession(tx, link.userId, link.orgId, userAgent);
  });
}

/**
 * First-time setup from the welcome email's questionnaire link. The link
 * already proves the owner reads that inbox. Only works until a login exists.
 */
export async function setUpOwnerLogin(
  db: Db, orgId: string, password: string, userAgent?: string | null,
): Promise<{ ok: true; token: string; expiresAt: Date } | { ok: false; reason: "no_owner" | "already_set" | "bad_password"; message?: string }> {
  const owner = await ownerOf(db, orgId);
  if (!owner) return { ok: false, reason: "no_owner" };
  if (owner.login_ready_at) return { ok: false, reason: "already_set" };
  const problem = passwordProblem(password, owner.email);
  if (problem) return { ok: false, reason: "bad_password", message: problem };
  const hash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `update app.users set password_hash = $2, password_changed_at = now(), login_ready_at = now()
        where id = $1 and login_ready_at is null returning id`, [owner.id, hash]);
    if (!rows.length) return { ok: false as const, reason: "already_set" as const };
    await audit(tx, orgId, `customer:${owner.id}`, "login.set_up");
    const s = await createSession(tx, owner.id, orgId, userAgent);
    return { ok: true as const, token: s.token, expiresAt: s.expiresAt };
  });
}

// ---------------------------------------------------------------------------
// Teammates
// ---------------------------------------------------------------------------
export type Teammate = {
  user_id: string; email: string; full_name: string | null; role: "owner" | "member"; status: "active" | "invited";
  last_sign_in_at: string | null; login_ready: boolean;
};

export async function listTeam(db: Queryable, orgId: string): Promise<Teammate[]> {
  return (await db.query<Teammate>(
    `select u.id as user_id, u.email, u.full_name, m.role, m.status, u.last_sign_in_at, (u.login_ready_at is not null) as login_ready
       from app.memberships m join app.users u on u.id = m.user_id
      where m.org_id = $1 order by (m.role = 'owner') desc, m.created_at`, [orgId])).rows;
}

export type InviteResult = "sent" | "bad_email" | "already_member" | "too_many" | "not_owner" | "email_failed";

/** The owner invites someone by email. They get a link to set up their login (or just join, if they have one). */
export async function inviteTeammate(db: Db, s: Pick<CustomerSession, "userId" | "orgId" | "role" | "fullName" | "email" | "orgName">, emailIn: string, nameIn: string): Promise<InviteResult> {
  if (s.role !== "owner") return "not_owner";
  const email = normalizeEmail(emailIn);
  if (!validEmail(email)) return "bad_email";
  const name = String(nameIn ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
  const out = await db.transaction(async (tx) => {
    const team = await listTeam(tx, s.orgId);
    if (team.some((t) => t.email.toLowerCase() === email && t.status === "active")) return { r: "already_member" as const };
    if (team.filter((t) => t.role === "member").length >= MAX_TEAMMATES && !team.some((t) => t.email.toLowerCase() === email)) {
      return { r: "too_many" as const };
    }
    const userId = (await userByEmail(tx, email))?.id ?? (await tx.query<{ id: string }>(
      `insert into app.users (email, full_name) values ($1, nullif($2, '')) returning id`, [email, name])).rows[0].id;
    await tx.query(
      `insert into app.memberships (org_id, user_id, role, status, invited_by, invited_at) values ($1, $2, 'member', 'invited', $3, now())
       on conflict (org_id, user_id) do update set invited_by = $3, invited_at = now()`, [s.orgId, userId, s.userId]);
    const link = await createLoginLink(tx, userId, s.orgId, "invite");
    await audit(tx, s.orgId, `customer:${s.userId}`, "team.invited", { email });
    return { r: "sent" as const, link };
  });
  if (out.r !== "sent") return out.r;
  const inviter = s.fullName?.trim() || s.email;
  try {
    await sendEmail(db, { orgId: s.orgId, kind: "team_invite", dedupeKey: `login:${out.link.id}`, to: email,
      ...teammateInvite(inviter, s.orgName, out.link.url) });
  } catch (err) {
    console.error("invite email failed:", (err as Error).message);
    return "email_failed";
  }
  return "sent";
}

/** The owner removes a teammate (or cancels an invite). They're signed out of this business right away. */
export async function removeTeammate(db: Db, s: Pick<CustomerSession, "userId" | "orgId" | "role">, userId: string): Promise<"ok" | "not_owner" | "not_found"> {
  if (s.role !== "owner") return "not_owner";
  if (userId === s.userId) return "not_found";
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ email: string }>(
      `delete from app.memberships m using app.users u
        where m.org_id = $1 and m.user_id = $2 and m.role = 'member' and u.id = m.user_id returning u.email`, [s.orgId, userId]);
    if (!rows.length) return "not_found" as const;
    await tx.query(`update app.customer_sessions set revoked_at = now() where user_id = $1 and org_id = $2 and revoked_at is null`, [userId, s.orgId]);
    await tx.query(`update app.login_links set used_at = now() where user_id = $1 and org_id = $2 and used_at is null`, [userId, s.orgId]);
    await audit(tx, s.orgId, `customer:${s.userId}`, "team.removed", { email: rows[0].email });
    return "ok" as const;
  });
}
