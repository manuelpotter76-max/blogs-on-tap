import type { Db, Queryable } from "@/lib/db/client";
import { createLink, linkUrl, type LinkPurpose } from "@/lib/links";
import { sendEmail } from "@/lib/email/send";
import { articleReady, onboardingInvite, profileReview, topicReview } from "@/lib/email/templates";
import { runBusinessResearch } from "@/lib/agents/business-research";
import { runContentStrategy } from "@/lib/agents/content-strategy";
import { runWebsiteFetch } from "@/lib/onboarding/website-task";
import { PermanentError, type Handler, type Task, type TaskKind } from "./queue";

async function owner(db: Queryable, orgId: string): Promise<{ email: string; name: string }> {
  const { rows } = await db.query<{ email: string; name: string }>(
    `select u.email, o.name from app.organizations o
       join app.memberships m on m.org_id = o.id and m.role = 'owner'
       join app.users u on u.id = m.user_id
      where o.id = $1 order by m.created_at limit 1`, [orgId]);
  if (!rows[0]) throw new PermanentError("customer has no owner email");
  return rows[0];
}

/** Reuse a live link for the same purpose and subject, so a retried email carries the same link. */
export async function liveLink(db: Queryable, orgId: string, purpose: LinkPurpose, subjectId: string | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `select id from app.access_links
      where org_id = $1 and purpose = $2 and subject_id is not distinct from $3
        and revoked_at is null and expires_at > now() + interval '2 days'
      order by created_at desc limit 1`, [orgId, purpose, subjectId]);
  return rows[0]?.id ?? createLink(db, orgId, purpose, subjectId);
}

const sendOnboardingInvite: Handler = async (db, task) => {
  const done = await db.query(
    `select 1 from app.onboarding_responses where org_id = $1 and submitted_at is not null`, [task.org_id]);
  if (done.rows.length) return;
  const who = await owner(db, task.org_id);
  const linkId = await liveLink(db, task.org_id, "onboarding", null);
  const name = who.name === "New customer" ? "there" : who.name;
  const mail = onboardingInvite(name, linkUrl(linkId, "onboarding"));
  await sendEmail(db, { orgId: task.org_id, kind: "onboarding_invite", dedupeKey: `onboarding_invite:${linkId}`,
    to: who.email, linkId, ...mail });
};

const sendProfileReview: Handler = async (db, task) => {
  const version = Number(task.payload.version);
  const pv = (await db.query<{ id: string; status: string; current_version: number }>(
    `select pv.id, bp.status, bp.current_version from app.profile_versions pv
       join app.business_profiles bp on bp.org_id = pv.org_id
      where pv.org_id = $1 and pv.version = $2`, [task.org_id, version])).rows[0];
  if (!pv || pv.status !== "awaiting_customer" || pv.current_version !== version) return;   // superseded
  const who = await owner(db, task.org_id);
  const linkId = await liveLink(db, task.org_id, "profile_review", pv.id);
  const mail = profileReview(who.name, linkUrl(linkId, "profile_review"));
  await sendEmail(db, { orgId: task.org_id, kind: "profile_review", dedupeKey: `profile_review:${pv.id}`,
    to: who.email, linkId, ...mail });
};

const sendTopicReview: Handler = async (db, task) => {
  const svId = String(task.payload.strategy_version_id ?? "");
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from app.topics where strategy_version_id = $1 and org_id = $2 and status = 'proposed'`,
    [svId, task.org_id]);
  if (!rows[0].n) return;
  const who = await owner(db, task.org_id);
  const linkId = await liveLink(db, task.org_id, "topic_review", svId);
  const mail = topicReview(rows[0].n, linkUrl(linkId, "topic_review"), Number(task.payload.round ?? 1));
  await sendEmail(db, { orgId: task.org_id, kind: "topic_review", dedupeKey: `topic_review:${svId}`,
    to: who.email, linkId, ...mail });
};

const sendArticle: Handler = async (db, task) => {
  const articleId = String(task.payload.article_id ?? "");
  const version = Number(task.payload.version);
  const a = (await db.query<{ job_id: string; topic_id: string; state: string; title: string; delivered_version: number | null }>(
    `select a.job_id, a.topic_id, j.state, v.content->>'seo_title' as title, a.delivered_version
       from app.articles a join app.production_jobs j on j.id = a.job_id
       join app.article_versions v on v.article_id = a.id and v.version = $3
      where a.id = $1 and a.org_id = $2`, [articleId, task.org_id, version])).rows[0];
  if (!a || a.state !== "ready_for_customer") return;   // changed since it was approved
  const who = await owner(db, task.org_id);
  const linkId = await liveLink(db, task.org_id, "article_review", articleId);
  const mail = articleReady(a.title, linkUrl(linkId, "article_review"), a.delivered_version !== null);
  await sendEmail(db, { orgId: task.org_id, kind: "article_ready", dedupeKey: `article_ready:${articleId}:v${version}`,
    to: who.email, linkId, ...mail });
  await db.transaction(async (tx) => {
    await tx.query(
      `update app.articles set delivered_version = $2, delivered_at = now(), updated_at = now() where id = $1`,
      [articleId, version]);
    await tx.query(
      `update app.production_jobs set state = 'delivered', step = 'customer', updated_at = now()
        where id = $1 and state = 'ready_for_customer'`, [a.job_id]);
    await tx.query(`update app.topics set status = 'used' where id = $1`, [a.topic_id]);
    await tx.query(
      `insert into app.audit_events (org_id, actor, action, target, details) values ($1, 'system', 'article.delivered', $2, $3)`,
      [task.org_id, a.job_id, JSON.stringify({ version })]);
  });
};

export const HANDLERS: Record<TaskKind, Handler> = {
  send_onboarding_invite: sendOnboardingInvite,
  website_fetch: (db: Db, task: Task) => runWebsiteFetch(db, task),
  business_research: (db: Db, task: Task) => runBusinessResearch(db, task),
  send_profile_review: sendProfileReview,
  content_strategy: (db: Db, task: Task) => runContentStrategy(db, task),
  send_topic_review: sendTopicReview,
  send_article: sendArticle,
};
