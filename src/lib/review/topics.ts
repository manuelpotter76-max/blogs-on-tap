import type { Db, Queryable } from "@/lib/db/client";
import { enqueue } from "@/lib/tasks/queue";
import { articlesPerCycle, targetPool } from "@/lib/agents/content-strategy";

export type ReviewTopic = {
  id: string; title: string; primary_keyword: string; search_intent: string; audience: string;
  business_objective: string; angle: string; subtopics: string[]; cta: string; status: string;
};

export async function loadTopicsForReview(db: Queryable, orgId: string, strategyVersionId: string): Promise<{
  topics: ReviewTopic[]; summary: string; open: boolean;
} | null> {
  const sv = (await db.query<{ data: { summary?: string } }>(
    `select data from app.strategy_versions where id = $1 and org_id = $2`, [strategyVersionId, orgId])).rows[0];
  if (!sv) return null;
  const topics = (await db.query<ReviewTopic>(
    `select id, title, primary_keyword, search_intent, audience, business_objective, angle, subtopics, cta, status
       from app.topics where strategy_version_id = $1 and org_id = $2 order by priority, created_at`,
    [strategyVersionId, orgId])).rows;
  return { topics, summary: sv.data.summary ?? "", open: topics.some((t) => t.status === "proposed") };
}

export type TopicDecision = { id: string; approve: boolean; note: string };

export type DecideResult =
  | { ok: true; approved: number; moreComing: boolean }
  | { ok: false; reason: "closed" | "undecided" };

/**
 * Customer approves or skips each proposed topic from one batch. Any approval
 * opens production (acceptance test 4). If the approved pool is short of two
 * months' worth, the strategist proposes more, learning from the skips.
 */
export async function decideTopics(db: Db, orgId: string, strategyVersionId: string, decisions: TopicDecision[]): Promise<DecideResult> {
  return db.transaction(async (tx) => {
    await tx.query(`select 1 from app.content_strategies where org_id = $1 for update`, [orgId]);
    const pending = (await tx.query<{ id: string }>(
      `select id from app.topics where strategy_version_id = $1 and org_id = $2 and status = 'proposed'`,
      [strategyVersionId, orgId])).rows;
    if (!pending.length) return { ok: false, reason: "closed" } as const;

    const byId = new Map(decisions.map((d) => [d.id, d]));
    if (!pending.every((p) => byId.has(p.id))) return { ok: false, reason: "undecided" } as const;

    let approvedNow = 0;
    for (const p of pending) {
      const d = byId.get(p.id)!;
      await tx.query(
        `update app.topics set status = $3, customer_note = nullif($4, ''), decided_at = now(), decided_by = 'customer'
          where id = $1 and org_id = $2 and status = 'proposed'`,
        [p.id, orgId, d.approve ? "approved" : "rejected", String(d.note ?? "").trim().slice(0, 1000)]);
      if (d.approve) approvedNow++;
    }

    const { rows } = await tx.query<{ approved: number; ever: number }>(
      `select count(*) filter (where status = 'approved')::int as approved,
              count(*) filter (where status in ('approved', 'in_production', 'used'))::int as ever
         from app.topics where org_id = $1`, [orgId]);
    const { approved, ever } = rows[0];

    await tx.query(
      `update app.content_strategies set status = $2, updated_at = now() where org_id = $1`,
      [orgId, ever > 0 ? "approved" : "generating"]);
    await tx.query(
      `insert into app.audit_events (org_id, actor, action, target, details) values ($1, 'customer', 'topics.decided', $2, $3)`,
      [orgId, strategyVersionId, JSON.stringify({ approved: approvedNow, skipped: pending.length - approvedNow })]);

    const perCycle = await articlesPerCycle(tx, orgId);
    const moreComing = approved < targetPool(perCycle);
    if (moreComing) {
      await enqueue(tx, orgId, "content_strategy", `content_strategy:${orgId}:after:${strategyVersionId}`);
    }
    return { ok: true, approved: approvedNow, moreComing } as const;
  });
}
