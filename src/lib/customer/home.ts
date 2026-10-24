import { asTenant, type Db } from "../db/client";
import { linkUrl, type LinkPurpose } from "../links";
import { liveLink } from "../tasks/handlers";

/**
 * Dashboard home for one business. Everything about the business is read
 * under the restricted tenant role, so the database itself keeps one
 * customer from seeing another's rows. Links to the existing review pages
 * are then looked up (or refreshed if they expired) server-side.
 */
export type NeedsYou = { kind: "onboarding" | "profile" | "topics" | "article"; label: string; detail: string; href: string };
export type RecentArticle = { title: string; state: "delivered" | "approved" | "revising"; deliveredAt: string; href: string };
export type Home = {
  plan: { name: string; perMonth: number; status: string; renewsOn: string | null } | null;
  month: { ready: number; inWorks: number; notStarted: number } | null;
  needsYou: NeedsYou[];
  recent: RecentArticle[];
};

type Facts = {
  plan: Home["plan"];
  month: Home["month"];
  onboardingOpen: boolean;
  profileVersionId: string | null;
  topics: { strategyVersionId: string; count: number } | null;
  waiting: { articleId: string; title: string; deliveredAt: string; autoApproveOn: string | null }[];
  recent: { articleId: string; title: string; state: string; deliveredAt: string }[];
};

export async function getHome(db: Db, orgId: string): Promise<Home> {
  const f = await asTenant<Facts>(db, orgId, async (tx) => {
    const sub = (await tx.query<{ name: string; per_month: number; status: string; renews: string | null; sub_id: string }>(
      `select p.name, pv.articles_per_cycle as per_month, s.status, s.current_period_end as renews, s.id as sub_id
         from app.subscriptions s join app.plan_versions pv on pv.id = s.plan_version_id join app.plans p on p.id = pv.plan_id
        order by s.created_at desc limit 1`)).rows[0];

    const cycle = (await tx.query<{ cycle_id: string; available: number }>(
      `select cycle_id, available from app.cycle_balances where status = 'open' order by period_start desc limit 1`)).rows[0];
    let month: Home["month"] = null;
    if (cycle) {
      const j = (await tx.query<{ ready: number; in_works: number }>(
        `select count(*) filter (where state in ('delivered', 'customer_approved'))::int as ready,
                count(*) filter (where state not in ('delivered', 'customer_approved', 'cancelled'))::int as in_works
           from app.production_jobs where cycle_id = $1`, [cycle.cycle_id])).rows[0];
      month = { ready: j.ready, inWorks: j.in_works, notStarted: Math.max(0, cycle.available) };
    }

    const onboarding = (await tx.query<{ submitted_at: string | null }>(
      `select submitted_at from app.onboarding_responses limit 1`)).rows[0];
    const profile = (await tx.query<{ id: string }>(
      `select pv.id from app.business_profiles bp
         join app.profile_versions pv on pv.org_id = bp.org_id and pv.version = bp.current_version
        where bp.status = 'awaiting_customer'`)).rows[0];
    const topics = (await tx.query<{ strategy_version_id: string; n: number }>(
      `select strategy_version_id, count(*)::int as n from app.topics where status = 'proposed'
        group by strategy_version_id order by max(created_at) desc limit 1`)).rows[0];
    const waiting = (await tx.query<Facts["waiting"][number]>(
      `select a.id as "articleId", coalesce(nullif(trim(v.content->>'seo_title'), ''), 'Your new article') as title,
              a.delivered_at as "deliveredAt",
              (a.delivered_at + make_interval(days => pv.revision_window_days))::date::text as "autoApproveOn"
         from app.articles a
         join app.production_jobs j on j.id = a.job_id and j.state = 'delivered'
         join app.article_versions v on v.article_id = a.id and v.version = a.delivered_version
         left join app.entitlement_cycles c on c.id = j.cycle_id
         left join app.subscriptions s on s.id = c.subscription_id
         left join app.plan_versions pv on pv.id = s.plan_version_id
        order by a.delivered_at`)).rows;
    const recent = (await tx.query<Facts["recent"][number]>(
      `select a.id as "articleId", coalesce(nullif(trim(v.content->>'seo_title'), ''), 'Untitled article') as title,
              j.state, a.delivered_at as "deliveredAt"
         from app.articles a
         join app.production_jobs j on j.id = a.job_id
         join app.article_versions v on v.article_id = a.id and v.version = a.delivered_version
        where a.delivered_at is not null
        order by a.delivered_at desc limit 6`)).rows;

    return {
      plan: sub ? { name: sub.name, perMonth: sub.per_month, status: sub.status, renewsOn: sub.renews } : null,
      month,
      onboardingOpen: Boolean(sub) && !onboarding?.submitted_at,
      profileVersionId: profile?.id ?? null,
      topics: topics ? { strategyVersionId: topics.strategy_version_id, count: topics.n } : null,
      waiting,
      recent,
    };
  });

  const url = async (purpose: LinkPurpose, subject: string | null) => linkUrl(await liveLink(db, orgId, purpose, subject), purpose);
  const needsYou: NeedsYou[] = [];
  if (f.onboardingOpen) {
    needsYou.push({ kind: "onboarding", label: "Finish the questionnaire", detail: "We need it before we can write anything.",
      href: await url("onboarding", null) });
  }
  if (f.profileVersionId) {
    needsYou.push({ kind: "profile", label: "Check your business profile", detail: "Every article leans on it. Nothing is written until you confirm it.",
      href: await url("profile_review", f.profileVersionId) });
  }
  if (f.topics) {
    needsYou.push({ kind: "topics", label: `Pick from ${f.topics.count} topic idea${f.topics.count === 1 ? "" : "s"}`,
      detail: "Approve the ones you like. Writing starts as soon as you do.", href: await url("topic_review", f.topics.strategyVersionId) });
  }
  for (const w of f.waiting) {
    needsYou.push({ kind: "article", label: `Read "${w.title}"`,
      detail: w.autoApproveOn ? `Approve it or ask for changes. If we don't hear from you, it's approved on ${fmtDay(w.autoApproveOn)}.` : "Approve it or ask for changes.",
      href: await url("article_review", w.articleId) });
  }

  const recent: RecentArticle[] = [];
  for (const r of f.recent) {
    recent.push({
      title: r.title, deliveredAt: r.deliveredAt, href: await url("article_review", r.articleId),
      state: r.state === "customer_approved" ? "approved" : r.state === "delivered" ? "delivered" : "revising",
    });
  }
  return { plan: f.plan, month: f.month, needsYou, recent };
}

function fmtDay(isoDay: string): string {
  return new Date(`${isoDay}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/New_York" });
}
