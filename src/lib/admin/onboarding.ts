import type { Db, Queryable } from "../db/client";
import { enqueue, retryTask } from "../tasks/queue";
import { linkUrl, type LinkPurpose } from "../links";
import type { BusinessProfile } from "../agents/business-profile";

export type OnboardingOverview = {
  onboarding: { current_step: number; website_consent: boolean; submitted_at: string | null; updated_at: string } | null;
  profile: { status: string; current_version: number | null; confirmed_at: string | null; data: BusinessProfile | null } | null;
  strategy: { status: string; current_version: number | null; review_rounds: number } | null;
  topicCounts: Record<string, number>;
  topics: { id: string; title: string; primary_keyword: string; status: string; customer_note: string | null; priority: number }[];
  files: { filename: string | null; kind: string; source_url: string | null; status: string; size_bytes: number | null }[];
  aiRuns: { started_at: string; stage: string; model: string; prompt_version: string; status: string;
    input_tokens: number | null; output_tokens: number | null; cost_usd: string | null; error: string | null }[];
  aiTotalUsd: number;
  tasks: { id: string; kind: string; state: string; attempts: number; last_error: string | null; updated_at: string }[];
  emails: { created_at: string; kind: string; to_email: string; status: string; provider: string | null; error: string | null }[];
  links: { purpose: LinkPurpose; url: string; expires_at: string }[];
};

export async function getOnboardingOverview(db: Db, orgId: string): Promise<OnboardingOverview> {
  const q = <T>(sql: string) => db.query<T>(sql, [orgId]).then((r) => r.rows);
  const [onb, prof, strat, counts, topics, files, runs, total, tasks, emails, links] = await Promise.all([
    q<NonNullable<OnboardingOverview["onboarding"]>>(
      `select current_step, website_consent, submitted_at, updated_at from app.onboarding_responses where org_id = $1`),
    q<NonNullable<OnboardingOverview["profile"]>>(
      `select bp.status, bp.current_version, bp.confirmed_at, pv.data from app.business_profiles bp
         left join app.profile_versions pv on pv.org_id = bp.org_id and pv.version = bp.current_version
        where bp.org_id = $1`),
    q<NonNullable<OnboardingOverview["strategy"]>>(
      `select status, current_version, review_rounds from app.content_strategies where org_id = $1`),
    q<{ status: string; n: number }>(`select status, count(*)::int as n from app.topics where org_id = $1 group by status`),
    q<OnboardingOverview["topics"][number]>(
      `select id, title, primary_keyword, status, customer_note, priority from app.topics where org_id = $1
        order by case status when 'proposed' then 0 when 'approved' then 1 when 'in_production' then 2 else 3 end,
                 priority, created_at limit 60`),
    q<OnboardingOverview["files"][number]>(
      `select filename, kind, source_url, status, size_bytes from app.source_documents where org_id = $1
        order by kind, created_at`),
    q<OnboardingOverview["aiRuns"][number]>(
      `select started_at, stage, model, prompt_version, status, input_tokens, output_tokens, cost_usd::text, error
         from app.ai_runs where org_id = $1 order by started_at desc limit 20`),
    q<{ usd: string | null }>(`select sum(cost_usd)::text as usd from app.ai_runs where org_id = $1`),
    q<OnboardingOverview["tasks"][number]>(
      `select id, kind, state, attempts, last_error, updated_at from app.pipeline_tasks where org_id = $1
        order by created_at desc limit 20`),
    q<OnboardingOverview["emails"][number]>(
      `select created_at, kind, to_email, status, provider, error from app.notifications where org_id = $1
        order by created_at desc limit 20`),
    q<{ id: string; purpose: LinkPurpose; expires_at: string }>(
      `select distinct on (purpose) id, purpose, expires_at from app.access_links
        where org_id = $1 and revoked_at is null and expires_at > now() order by purpose, created_at desc`),
  ]);

  let liveLinks: OnboardingOverview["links"] = [];
  try {
    liveLinks = links.map((l) => ({ purpose: l.purpose, url: linkUrl(l.id, l.purpose), expires_at: l.expires_at }));
  } catch {
    // LINK_SECRET or APP_BASE_URL not set: just don't show links.
  }

  return {
    onboarding: onb[0] ?? null,
    profile: prof[0] ?? null,
    strategy: strat[0] ?? null,
    topicCounts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    topics,
    files,
    aiRuns: runs,
    aiTotalUsd: Number(total[0]?.usd ?? 0),
    tasks,
    emails,
    links: liveLinks,
  };
}

async function audit(db: Queryable, orgId: string, adminId: string, action: string, details: object = {}) {
  await db.query(
    `insert into app.audit_events (org_id, actor, action, target, details) values ($1, $2, $3, $4, $5)`,
    [orgId, `admin:${adminId}`, action, orgId, JSON.stringify(details)]);
}

export type AdminOnboardingAction = "resend_invite" | "rerun_research" | "more_topics" | "retry_task";

/** Admin recovery tools. Each one is queued work, so it inherits retries and dedupe. */
export async function runAdminOnboardingAction(
  db: Db, adminId: string, orgId: string, action: AdminOnboardingAction, taskId?: string,
): Promise<"ok" | "not_allowed" | "not_found"> {
  const stamp = Date.now();
  return db.transaction(async (tx) => {
    const org = await tx.query(`select 1 from app.organizations where id = $1`, [orgId]);
    if (!org.rows.length) return "not_found";

    if (action === "resend_invite") {
      const done = await tx.query(`select 1 from app.onboarding_responses where org_id = $1 and submitted_at is not null`, [orgId]);
      if (done.rows.length) return "not_allowed";
      // Old links stop working; the new email carries a fresh one.
      await tx.query(
        `update app.access_links set revoked_at = now() where org_id = $1 and purpose = 'onboarding' and revoked_at is null`, [orgId]);
      await enqueue(tx, orgId, "send_onboarding_invite", `send_onboarding_invite:${orgId}:admin:${stamp}`);
      await audit(tx, orgId, adminId, "onboarding.link_resent");
      return "ok";
    }
    if (action === "rerun_research") {
      const { rows } = await tx.query<{ status: string; website_consent: boolean }>(
        `select bp.status, o.website_consent from app.business_profiles bp join app.onboarding_responses o on o.org_id = bp.org_id
          where bp.org_id = $1 and o.submitted_at is not null`, [orgId]);
      if (!rows[0] || rows[0].status === "confirmed") return "not_allowed";
      await tx.query(`update app.business_profiles set status = 'researching', updated_at = now() where org_id = $1`, [orgId]);
      const researchKey = `business_research:${orgId}:admin:${stamp}`;
      // Re-read the website first (if they allowed it), so fixes to the reader and site changes are picked up.
      if (rows[0].website_consent) {
        await enqueue(tx, orgId, "website_fetch", `website_fetch:${orgId}:admin:${stamp}`, { next_key: researchKey });
      } else {
        await enqueue(tx, orgId, "business_research", researchKey);
      }
      await audit(tx, orgId, adminId, "profile.research_rerun");
      return "ok";
    }
    if (action === "more_topics") {
      const { rows } = await tx.query(`select 1 from app.business_profiles where org_id = $1 and status = 'confirmed'`, [orgId]);
      if (!rows.length) return "not_allowed";
      // An admin request also lifts the "skipped every batch" hold.
      await tx.query(
        `update app.content_strategies set review_rounds = 0,
                status = case when status = 'needs_admin' then 'generating' else status end, updated_at = now()
          where org_id = $1`, [orgId]);
      await enqueue(tx, orgId, "content_strategy", `content_strategy:${orgId}:admin:${stamp}`);
      await audit(tx, orgId, adminId, "strategy.more_requested");
      return "ok";
    }
    if (action === "retry_task" && taskId) {
      if (!(await retryTask(tx, taskId, orgId))) return "not_found";
      await audit(tx, orgId, adminId, "task.retried", { task_id: taskId });
      return "ok";
    }
    return "not_allowed";
  });
}
