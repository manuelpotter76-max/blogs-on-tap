import type { Db, Queryable } from "@/lib/db/client";
import { arr, int, obj, oneOf, str, type Schema } from "@/lib/ai/json-schema";
import { callStructured, modelFor, type Fetcher } from "@/lib/ai/openai";
import { enqueue, PermanentError, type Task } from "@/lib/tasks/queue";
import type { BusinessProfile } from "./business-profile";
import { filterFresh, topicKey, type Known } from "./dedupe";
import { alertAdmin } from "@/lib/email/admin-alerts";

/** Agent B: Content Strategy. Bump PROMPT_VERSION whenever the instructions change. */
export const PROMPT_VERSION = "content_strategy.v2";
export const MAX_REVIEW_ROUNDS = 4;

const TOPIC: Schema = obj({
  title: str("Working title. Specific, useful, written for a person, not a search engine."),
  primary_keyword: str("The natural phrase a customer would search. Not a claim about search volume."),
  search_intent: oneOf(["informational", "commercial", "transactional", "local"]),
  audience: str("Which reader this is for, from the profile's audience"),
  business_objective: str("Which service this supports and why it helps the business"),
  angle: str("What makes this article genuinely useful and different, in one or two sentences"),
  subtopics: arr(str(), "Three to six sections the article should cover", 8),
  cta: str("The call to action, adapted to this article"),
  internal_link_ideas: arr(str("A related service or topic on the customer's site to link to"), undefined, 5),
  pillar: str("Which content pillar this belongs to"),
  priority: int("1 is most valuable to write first", 1, 99),
});

export const STRATEGY_SCHEMA: Schema = obj({
  summary: str("Two or three sentences on the overall approach for this business"),
  pillars: arr(obj({ name: str(), why: str() }), "Three to five content themes", 6),
  topics: arr(TOPIC, undefined, 30),
});

export type StrategyTopic = {
  title: string; primary_keyword: string; search_intent: string; audience: string; business_objective: string;
  angle: string; subtopics: string[]; cta: string; internal_link_ideas: string[]; pillar: string; priority: number;
};
export type StrategyOutput = { summary: string; pillars: { name: string; why: string }[]; topics: StrategyTopic[] };

export const INSTRUCTIONS = `You are the editorial strategist for a small-business blog service. From a confirmed business profile, propose blog articles that bring the right customers to this business and genuinely help readers.

Rules:
- Every topic must tie to a service the business actually offers, for the audience it actually serves. No off-topic or generic filler.
- Favor what real customers ask: the profile's FAQs, pain points and priority topics come first.
- Local businesses: include topics that serve people in their service area, without stuffing place names.
- Each topic needs a distinct search intent and primary keyword. Never propose two articles that would compete for the same search.
- Do not repeat or closely rephrase anything in ALREADY COVERED. Learn from the customer's rejections and their notes.
- Never use the topics to avoid. Never build a topic around a prohibited claim.
- Do not invent search volumes, rankings, keyword difficulty or statistics. Do not promise results.
- Regulated fields (legal, medical, financial): keep topics educational and general, never individual advice.
- Titles: clear, specific and honest. No clickbait, no "ultimate guide" cliches, no colons stacked with buzzwords.
- Every topic must be writable from the profile plus widely known general knowledge. Don't propose topics that depend on facts we don't have, like rankings or reviews of named restaurants, shops or other businesses, prices, hours, event dates or quotes, unless the profile supplies them.
- Return exactly the number of topics requested, ordered by priority.`;

function profileText(p: BusinessProfile): string {
  return JSON.stringify({
    business_name: p.business_name, summary: p.summary, industry: p.industry,
    service_area_type: p.service_area_type, service_area: p.service_area,
    services: p.services.map((s) => ({ name: s.name, description: s.description, priority: s.priority })),
    audience: p.audience.map((a) => a.text), pain_points: p.pain_points.map((a) => a.text),
    differentiators: p.differentiators.map((a) => a.text), faqs: p.faqs,
    cta: p.cta, prohibited_claims: p.prohibited_claims, topics_to_avoid: p.topics_to_avoid,
    priority_topics: p.priority_topics, regulated_field: p.compliance.regulated_field,
  }, null, 2);
}

export async function articlesPerCycle(db: Queryable, orgId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select pv.articles_per_cycle as n from app.subscriptions s
       join app.plan_versions pv on pv.id = s.plan_version_id
      where s.org_id = $1 order by s.created_at desc limit 1`, [orgId]);
  return rows[0]?.n ?? 2;
}

/** How many approved, unwritten topics we aim to keep on hand: two cycles' worth. */
export function targetPool(perCycle: number): number {
  return perCycle * 2;
}

export function proposalCount(perCycle: number, approvedUnused: number, round: number): number {
  if (round === 1) return Math.min(16, Math.max(6, perCycle * 2 + 2));
  return Math.min(12, Math.max(4, targetPool(perCycle) - approvedUnused + 2));
}

export async function runContentStrategy(db: Db, task: Task, fetcher?: Fetcher): Promise<void> {
  const orgId = task.org_id;
  const already = await db.query(
    `select 1 from app.strategy_versions sv join app.ai_runs r on r.id = sv.ai_run_id where r.task_id = $1`, [task.id]);
  if (already.rows.length) return;

  const prof = (await db.query<{ status: string; data: BusinessProfile; version: number }>(
    `select bp.status, pv.data, pv.version from app.business_profiles bp
       join app.profile_versions pv on pv.org_id = bp.org_id and pv.version = bp.current_version
      where bp.org_id = $1`, [orgId])).rows[0];
  if (prof?.status !== "confirmed") throw new PermanentError("profile is not confirmed");   // acceptance test 4 groundwork

  const strat = (await db.query<{ review_rounds: number; status: string }>(
    `select review_rounds, status from app.content_strategies where org_id = $1`, [orgId])).rows[0];
  const round = (strat?.review_rounds ?? 0) + 1;
  // A customer who keeps skipping everything gets a person, not a fifth AI batch.
  if (round > MAX_REVIEW_ROUNDS && strat?.status !== "approved") {
    await db.query(
      `update app.content_strategies set status = 'needs_admin', updated_at = now() where org_id = $1`, [orgId]);
    await db.query(
      `insert into app.audit_events (org_id, actor, action, target, details) values ($1, 'system', 'strategy.needs_admin', $2, '{}')`,
      [orgId, orgId]);
    await alertAdmin(db, { orgId, kind: "strategy_needs_admin", dedupeKey: `strategy_needs_admin:${orgId}:${round}`,
      detail: `They skipped every topic in ${MAX_REVIEW_ROUNDS} batches. Talk to them, then use "Draft more topics".`,
      path: `/admin/customers/${orgId}#onboarding` });
    return;
  }

  const topics = (await db.query<{ title: string; primary_keyword: string; status: string; customer_note: string | null }>(
    `select title, primary_keyword, status, customer_note from app.topics where org_id = $1 order by created_at`, [orgId])).rows;
  const perCycle = await articlesPerCycle(db, orgId);
  const approvedUnused = topics.filter((t) => t.status === "approved").length;
  const count = proposalCount(perCycle, approvedUnused, round);

  const covered = [
    ...prof.data.existing_content.map((t) => `- ${t} (already published)`),
    ...topics.filter((t) => t.status !== "rejected").map((t) => `- ${t.title} (${t.status})`),
  ];
  const rejected = topics.filter((t) => t.status === "rejected")
    .map((t) => `- ${t.title}${t.customer_note ? ` (customer said: ${t.customer_note.replace(/\s+/g, " ").slice(0, 300)})` : ""}`);

  const input = [
    `CONFIRMED BUSINESS PROFILE\n${profileText(prof.data)}`,
    `ALREADY COVERED (do not repeat)\n${covered.join("\n") || "- nothing yet"}`,
    `REJECTED BY THE CUSTOMER (avoid these and anything like them)\n${rejected.join("\n") || "- none"}`,
    `The customer receives ${perCycle} articles a month. Propose exactly ${count} topics.`,
  ].join("\n\n");

  const result = await callStructured<StrategyOutput>(db, {
    orgId, stage: "content_strategy", promptVersion: PROMPT_VERSION, model: modelFor("strategy"),
    instructions: INSTRUCTIONS, input: [{ type: "input_text", text: input }],
    schemaName: "content_strategy", schema: STRATEGY_SCHEMA,
    sourceRefs: [{ kind: "profile_version", version: prof.version }], taskId: task.id,
  }, fetcher);

  const known: Known[] = [
    ...prof.data.existing_content.map((title) => ({ title })),
    ...topics.map((t) => ({ title: t.title, primary_keyword: t.status === "rejected" ? null : t.primary_keyword })),
  ];
  const { kept, dropped } = filterFresh(result.data.topics.map((t) => ({ ...t, title: t.title.trim() })), known);
  const avoid = prof.data.topics_to_avoid.map((s) => s.toLowerCase()).filter((s) => s.length > 3);
  const fresh = kept.filter((t) => !avoid.some((a) => t.title.toLowerCase().includes(a)));
  if (!fresh.length) throw new Error(`no usable topics (${dropped.length} duplicates dropped)`);

  await db.transaction(async (tx) => {
    const { rows } = await tx.query<{ v: number }>(
      `select coalesce(max(version), 0) + 1 as v from app.strategy_versions where org_id = $1`, [orgId]);
    const version = rows[0].v;
    const { rows: sv } = await tx.query<{ id: string }>(
      `insert into app.strategy_versions (org_id, version, profile_version, data, created_by, ai_run_id)
       values ($1, $2, $3, $4, 'ai', $5) returning id`,
      [orgId, version, prof.version,
       JSON.stringify({ summary: result.data.summary, pillars: result.data.pillars, round, dropped }), result.runId]);

    let inserted = 0;
    for (const [i, t] of fresh.entries()) {
      const r = await tx.query<{ id: string }>(
        `insert into app.topics (org_id, strategy_version_id, topic_key, title, primary_keyword, search_intent, audience,
                                 business_objective, angle, subtopics, cta, internal_link_ideas, pillar, priority)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         on conflict (org_id, topic_key) do nothing returning id`,
        [orgId, sv[0].id, topicKey(t.title), t.title, t.primary_keyword, t.search_intent, t.audience,
         t.business_objective, t.angle, JSON.stringify(t.subtopics), t.cta, JSON.stringify(t.internal_link_ideas),
         t.pillar, (round - 1) * 100 + Math.min(99, t.priority || i + 1)]);
      inserted += r.rows.length;
    }
    if (!inserted) throw new Error("every proposed topic was a duplicate");

    await tx.query(
      `insert into app.content_strategies (org_id, status, current_version, review_rounds)
       values ($1, 'awaiting_customer', $2, 1)
       on conflict (org_id) do update set
         status = case when app.content_strategies.status = 'approved' then 'approved' else 'awaiting_customer' end,
         current_version = $2, review_rounds = app.content_strategies.review_rounds + 1, updated_at = now()`,
      [orgId, version]);
    await tx.query(
      `insert into app.audit_events (org_id, actor, action, target, details) values ($1, 'system', 'strategy.drafted', $2, $3)`,
      [orgId, String(version), JSON.stringify({ topics: inserted, dropped: dropped.length, round, cost_usd: result.costUsd })]);
    await enqueue(tx, orgId, "send_topic_review", `send_topic_review:${orgId}:v${version}`,
      { strategy_version_id: sv[0].id, count: inserted, round });
  });
}
