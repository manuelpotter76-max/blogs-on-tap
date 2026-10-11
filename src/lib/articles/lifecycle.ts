import type { Queryable } from "@/lib/db/client";
import { sendEmail } from "@/lib/email/send";
import { articleReminder } from "@/lib/email/templates";
import { linkUrl } from "@/lib/links";

/**
 * Delivered articles don't wait forever. Three days before the plan's revision
 * window closes, the customer gets one reminder. When it closes with no
 * decision, the article counts as approved. Runs every worker tick; both steps
 * are idempotent.
 */
export const REMINDER_DAYS_BEFORE = 3;

type Due = { article_id: string; job_id: string; org_id: string; title: string; version: number; window_days: number;
  delivered_at: string; email: string };

const DUE_SQL = `
  select a.id as article_id, j.id as job_id, a.org_id, v.content->>'seo_title' as title, a.delivered_version as version,
         pv.revision_window_days as window_days, a.delivered_at,
         (select u.email from app.memberships m join app.users u on u.id = m.user_id
           where m.org_id = a.org_id and m.role = 'owner' order by m.created_at limit 1) as email
    from app.articles a
    join app.production_jobs j on j.id = a.job_id and j.state = 'delivered'
    join app.article_versions v on v.article_id = a.id and v.version = a.delivered_version
    join app.entitlement_cycles c on c.id = j.cycle_id
    join app.subscriptions s on s.id = c.subscription_id
    join app.plan_versions pv on pv.id = s.plan_version_id
   where a.delivered_at is not null and a.customer_decision is null`;

export async function autoApproveArticles(db: Queryable): Promise<number> {
  const { rows } = await db.query<Due>(
    `${DUE_SQL} and a.delivered_at + make_interval(days => pv.revision_window_days) <= now()`);
  let n = 0;
  for (const r of rows) {
    const done = await db.query(
      `update app.production_jobs set state = 'customer_approved', updated_at = now()
        where id = $1 and state = 'delivered' returning id`, [r.job_id]);
    if (!done.rows.length) continue;
    await db.query(
      `update app.articles set customer_decision = 'approved', customer_decided_at = now(), updated_at = now() where id = $1`,
      [r.article_id]);
    await db.query(
      `insert into app.audit_events (org_id, actor, action, target, details) values ($1, 'system', 'article.auto_approved', $2, $3)`,
      [r.org_id, r.job_id, JSON.stringify({ window_days: r.window_days })]);
    n++;
  }
  return n;
}

export async function remindAboutArticles(db: Queryable): Promise<number> {
  const { rows } = await db.query<Due & { link_id: string | null }>(
    `select d.*, (select l.id from app.access_links l where l.purpose = 'article_review' and l.subject_id = d.article_id
                    and l.revoked_at is null and l.expires_at > now() order by l.created_at desc limit 1) as link_id
       from (${DUE_SQL}
         and a.delivered_at + make_interval(days => pv.revision_window_days - $1) <= now()
         and a.delivered_at + make_interval(days => pv.revision_window_days) > now()) d`,
    [REMINDER_DAYS_BEFORE]);
  let n = 0;
  for (const r of rows) {
    if (!r.email || !r.link_id) continue;
    const msLeft = new Date(r.delivered_at).getTime() + r.window_days * 86_400_000 - Date.now();
    const daysLeft = Math.max(1, Math.ceil(msLeft / 86_400_000));
    try {
      const mail = articleReminder(r.title, linkUrl(r.link_id, "article_review"), daysLeft);
      const res = await sendEmail(db, { orgId: r.org_id, kind: "article_reminder",
        dedupeKey: `article_reminder:${r.article_id}:v${r.version}`, to: r.email, linkId: r.link_id, ...mail });
      if (res === "sent") n++;
    } catch (err) {
      console.error("article reminder failed", r.article_id, (err as Error).message);
    }
  }
  return n;
}
