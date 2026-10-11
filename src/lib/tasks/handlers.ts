import type { Db, Queryable } from "@/lib/db/client";
import { createLink, linkUrl, type LinkPurpose } from "@/lib/links";
import { sendEmail } from "@/lib/email/send";
import { onboardingInvite, profileReview, topicReview } from "@/lib/email/templates";
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

export const HANDLERS: Record<TaskKind, Handler> = {
  send_onboarding_invite: sendOnboardingInvite,
  website_fetch: (db: Db, task: Task) => runWebsiteFetch(db, task),
  business_research: (db: Db, task: Task) => runBusinessResearch(db, task),
  send_profile_review: sendProfileReview,
  content_strategy: (db: Db, task: Task) => runContentStrategy(db, task),
  send_topic_review: sendTopicReview,
};
