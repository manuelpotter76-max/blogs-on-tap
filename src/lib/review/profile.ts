import type { Db, Queryable } from "@/lib/db/client";
import { enqueue } from "@/lib/tasks/queue";
import { FACT_LISTS, type BusinessProfile, type FactList } from "@/lib/agents/business-profile";

export type ProfileForReview = {
  versionId: string;
  version: number;
  status: string;
  data: BusinessProfile;
  stale: boolean;          // a newer version exists than the one this link was sent for
};

export async function loadProfileForReview(db: Queryable, orgId: string, linkVersionId: string | null): Promise<ProfileForReview | null> {
  const { rows } = await db.query<{ id: string; version: number; data: BusinessProfile; status: string }>(
    `select pv.id, pv.version, pv.data, bp.status from app.business_profiles bp
       join app.profile_versions pv on pv.org_id = bp.org_id and pv.version = bp.current_version
      where bp.org_id = $1`, [orgId]);
  const r = rows[0];
  if (!r) return null;
  return { versionId: r.id, version: r.version, status: r.status, data: r.data, stale: !!linkVersionId && linkVersionId !== r.id };
}

export type ProfileDecision = {
  keep: Partial<Record<FactList, boolean[]>>;   // one entry per item, same order as shown
  summary: string;
  ctaText: string;
  ctaDestination: string;
  prohibitedClaims: string[];
  topicsToAvoid: string[];
  extraNotes: string;      // answers to open questions, or anything else to add
};

export type ConfirmResult =
  | { ok: true }
  | { ok: false; reason: "stale" | "not_awaiting" | "undecided" | "invalid"; detail?: string };

const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

/**
 * Customer confirms the profile. Builds a new, customer-owned version: items
 * they removed are gone, everything kept counts as confirmed. Then strategy
 * starts. Safe to call twice: the second call finds the profile confirmed.
 */
export async function confirmProfile(db: Db, orgId: string, versionId: string, d: ProfileDecision): Promise<ConfirmResult> {
  return db.transaction(async (tx) => {
    const cur = (await tx.query<{ id: string; version: number; data: BusinessProfile; status: string }>(
      `select pv.id, pv.version, pv.data, bp.status from app.business_profiles bp
         join app.profile_versions pv on pv.org_id = bp.org_id and pv.version = bp.current_version
        where bp.org_id = $1 for update of bp`, [orgId])).rows[0];
    if (!cur) return { ok: false, reason: "invalid" } as const;
    if (cur.status !== "awaiting_customer") return { ok: false, reason: "not_awaiting" } as const;
    if (cur.id !== versionId) return { ok: false, reason: "stale" } as const;

    const next: BusinessProfile = structuredClone(cur.data);
    for (const list of FACT_LISTS) {
      const items = cur.data[list] as { needs_confirmation: boolean }[];
      const keep = d.keep[list] ?? [];
      for (let i = 0; i < items.length; i++) {
        // Inferred items need an explicit answer; the customer's own items default to kept.
        if (keep[i] === undefined && items[i].needs_confirmation) {
          return { ok: false, reason: "undecided", detail: list } as const;
        }
      }
      (next[list] as { needs_confirmation: boolean }[]) = items
        .filter((_, i) => keep[i] ?? true)
        .map((x) => ({ ...x, needs_confirmation: false }));
    }

    const summary = clip(d.summary, 2000);
    const ctaText = clip(d.ctaText, 200);
    const ctaDest = clip(d.ctaDestination, 300);
    if (!summary || !ctaText || !ctaDest) return { ok: false, reason: "invalid", detail: "summary and call to action are required" } as const;
    if (!next.services.length) return { ok: false, reason: "invalid", detail: "keep at least one service" } as const;

    next.summary = summary;
    next.cta = { text: ctaText, destination: ctaDest };
    next.prohibited_claims = d.prohibitedClaims.map((s) => clip(s, 300)).filter(Boolean).slice(0, 20);
    next.topics_to_avoid = d.topicsToAvoid.map((s) => clip(s, 300)).filter(Boolean).slice(0, 25);
    const notes = clip(d.extraNotes, 3000);
    if (notes) next.facts = [...next.facts, { text: notes, source: "customer", needs_confirmation: false }];
    next.open_questions = notes ? [] : next.open_questions;

    const version = cur.version + 1;
    await tx.query(
      `insert into app.profile_versions (org_id, version, data, created_by) values ($1, $2, $3, 'customer')`,
      [orgId, version, JSON.stringify(next)]);
    await tx.query(
      `update app.business_profiles set status = 'confirmed', current_version = $2, confirmed_at = now(), updated_at = now()
        where org_id = $1`, [orgId, version]);
    await tx.query(
      `insert into app.audit_events (org_id, actor, action, target, details) values ($1, 'customer', 'profile.confirmed', $2, '{}')`,
      [orgId, String(version)]);
    await enqueue(tx, orgId, "content_strategy", `content_strategy:${orgId}:initial`);
    return { ok: true } as const;
  });
}
