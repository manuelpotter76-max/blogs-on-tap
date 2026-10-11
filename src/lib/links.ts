import { createHmac, timingSafeEqual } from "node:crypto";
import type { Queryable } from "@/lib/db/client";

/**
 * Customer links. A link token is "<link id>.<signature>", where the signature
 * is an HMAC of the id and purpose with LINK_SECRET. Nothing secret is stored,
 * so a database leak does not leak working links, and a failed email can be
 * re-sent with the same link. Links expire, and can be revoked (re-sending an
 * onboarding link revokes the old one).
 */
export type LinkPurpose = "onboarding" | "profile_review" | "topic_review";

export const LINK_DAYS: Record<LinkPurpose, number> = {
  onboarding: 30,
  profile_review: 21,
  topic_review: 21,
};

export const LINK_PATH: Record<LinkPurpose, string> = {
  onboarding: "/start",
  profile_review: "/review/profile",
  topic_review: "/review/topics",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secret(): string {
  const s = process.env.LINK_SECRET?.trim();
  if (!s || s.length < 32) throw new Error("LINK_SECRET must be set (at least 32 characters)");
  return s;
}

function sign(id: string, purpose: LinkPurpose): string {
  return createHmac("sha256", secret()).update(`${id}:${purpose}`).digest("base64url");
}

export function linkToken(id: string, purpose: LinkPurpose): string {
  return `${id}.${sign(id, purpose)}`;
}

export function linkUrl(id: string, purpose: LinkPurpose): string {
  const base = (process.env.APP_BASE_URL ?? "").trim().replace(/\/$/, "");
  if (!base) throw new Error("APP_BASE_URL must be set");
  return `${base}${LINK_PATH[purpose]}/${linkToken(id, purpose)}`;
}

export async function createLink(
  tx: Queryable, orgId: string, purpose: LinkPurpose, subjectId: string | null = null,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `insert into app.access_links (org_id, purpose, subject_id, expires_at)
     values ($1, $2, $3, now() + make_interval(days => $4)) returning id`,
    [orgId, purpose, subjectId, LINK_DAYS[purpose]]);
  return rows[0].id;
}

export type ValidLink = { id: string; org_id: string; purpose: LinkPurpose; subject_id: string | null };

/**
 * Checks signature, purpose, expiry and revocation. Returns null for anything
 * wrong, without saying which part, so a guessed link learns nothing.
 */
export async function resolveLink(db: Queryable, token: string, purpose: LinkPurpose): Promise<ValidLink | null> {
  const [id, sig] = String(token ?? "").split(".");
  if (!id || !sig || !UUID.test(id)) return null;
  const expected = Buffer.from(sign(id, purpose));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  const { rows } = await db.query<ValidLink>(
    `update app.access_links set last_used_at = now()
      where id = $1 and purpose = $2 and revoked_at is null and expires_at > now()
      returning id, org_id, purpose, subject_id`, [id, purpose]);
  return rows[0] ?? null;
}
