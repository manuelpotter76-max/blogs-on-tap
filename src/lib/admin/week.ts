import type { Db } from "../db/client";

/**
 * The admin's "this week" view: what needs a person now, what's waiting on
 * customers (with how long), and what's coming up in the next 7 days.
 */
export type WeekItem = { org_id: string; customer: string; what: string; when: string | null; href: string };

export type Week = { needsYou: WeekItem[]; waiting: WeekItem[]; comingUp: WeekItem[] };

export async function getWeek(db: Db): Promise<Week> {
  const q = <T>(sql: string) => db.query<T>(sql).then((r) => r.rows);
  const [review, failedJobs, failedTasks, badEmails, needsAdmin, stuck,
         onboarding, profiles, topics, delivered, renewals, ending] = await Promise.all([
    q<WeekItem>(`select j.org_id, o.name as customer,
                        'Review: ' || coalesce(v.content->>'seo_title', t.title) || case when j.flagged then ' (flagged)' else '' end as what,
                        j.updated_at::text as when, '/admin/articles/' || j.id as href
                   from app.production_jobs j join app.organizations o on o.id = j.org_id
                   left join app.topics t on t.id = j.topic_id
                   left join app.articles a on a.job_id = j.id
                   left join app.article_versions v on v.article_id = a.id and v.version = a.current_version
                  where j.state = 'admin_review' order by j.flagged desc, j.updated_at`),
    q<WeekItem>(`select j.org_id, o.name as customer, 'Article failed: ' || coalesce(t.title, 'untitled') as what,
                        j.updated_at::text as when, '/admin/articles/' || j.id as href
                   from app.production_jobs j join app.organizations o on o.id = j.org_id
                   left join app.topics t on t.id = j.topic_id where j.state = 'failed'`),
    q<WeekItem>(`select p.org_id, o.name as customer, 'Background step failed: ' || replace(p.kind, '_', ' ') as what,
                        p.updated_at::text as when, '/admin/customers/' || p.org_id || '#onboarding' as href
                   from app.pipeline_tasks p join app.organizations o on o.id = p.org_id where p.state = 'failed'`),
    q<WeekItem>(`select n.org_id, o.name as customer,
                        'Email may not have arrived: ' || replace(n.kind, '_', ' ') || ' to ' || n.to_email as what,
                        n.created_at::text as when, '/admin/customers/' || n.org_id || '#onboarding' as href
                   from app.notifications n join app.organizations o on o.id = n.org_id
                  where n.status in ('failed', 'uncertain') and n.kind not like 'admin_%'`),
    q<WeekItem>(`select cs.org_id, o.name as customer, 'Skipped every topic batch: talk to them' as what,
                        cs.updated_at::text as when, '/admin/customers/' || cs.org_id || '#onboarding' as href
                   from app.content_strategies cs join app.organizations o on o.id = cs.org_id where cs.status = 'needs_admin'`),
    // Paid credits that can't turn into articles: no approved topics and nothing on the way.
    q<WeekItem>(`select c.org_id, o.name as customer,
                        b.available || ' unused article credit(s) but no approved topics' as what,
                        c.period_end::text as when, '/admin/customers/' || c.org_id || '#onboarding' as href
                   from app.entitlement_cycles c
                   join app.cycle_balances b on b.cycle_id = c.id
                   join app.subscriptions s on s.id = c.subscription_id and s.status in ('active', 'cancel_scheduled')
                   join app.organizations o on o.id = c.org_id
                   join app.content_strategies cs on cs.org_id = c.org_id and cs.status = 'approved'
                  where c.status = 'open' and b.available > 0
                    and not exists (select 1 from app.topics t where t.org_id = c.org_id and t.status in ('approved', 'proposed'))
                    and not exists (select 1 from app.pipeline_tasks p where p.org_id = c.org_id and p.kind = 'content_strategy'
                                      and p.state in ('pending', 'running'))`),
    q<WeekItem>(`select o.id as org_id, o.name as customer,
                        case when r.org_id is null then 'Hasn''t opened the questionnaire'
                             else 'Questionnaire started, not sent (step ' || (r.current_step + 1) || ')' end as what,
                        coalesce(r.updated_at, s.created_at)::text as when, '/admin/customers/' || o.id || '#onboarding' as href
                   from app.organizations o
                   join app.subscriptions s on s.org_id = o.id and s.status in ('active', 'cancel_scheduled')
                   left join app.onboarding_responses r on r.org_id = o.id
                  where o.status = 'active' and (r.submitted_at is null)`),
    q<WeekItem>(`select bp.org_id, o.name as customer, 'Checking their business profile' as what,
                        bp.updated_at::text as when, '/admin/customers/' || bp.org_id || '#onboarding' as href
                   from app.business_profiles bp join app.organizations o on o.id = bp.org_id
                  where bp.status = 'awaiting_customer'`),
    q<WeekItem>(`select t.org_id, o.name as customer, 'Picking from ' || count(*) || ' topic ideas' as what,
                        min(t.created_at)::text as when, '/admin/customers/' || t.org_id || '#onboarding' as href
                   from app.topics t join app.organizations o on o.id = t.org_id
                  where t.status = 'proposed' group by t.org_id, o.name`),
    q<WeekItem>(`select a.org_id, o.name as customer,
                        'Reading "' || (v.content->>'seo_title') || '" (auto-approves ' ||
                          to_char((a.delivered_at + make_interval(days => pv.revision_window_days)) at time zone 'America/New_York', 'Mon DD') || ')' as what,
                        a.delivered_at::text as when, '/admin/articles/' || a.job_id as href
                   from app.articles a
                   join app.production_jobs j on j.id = a.job_id and j.state = 'delivered'
                   join app.article_versions v on v.article_id = a.id and v.version = a.delivered_version
                   join app.entitlement_cycles c on c.id = j.cycle_id
                   join app.subscriptions s on s.id = c.subscription_id
                   join app.plan_versions pv on pv.id = s.plan_version_id
                   join app.organizations o on o.id = a.org_id
                  order by a.delivered_at`),
    q<WeekItem>(`select s.org_id, o.name as customer,
                        p.name || ' renews: ' || pv.articles_per_cycle || ' new articles start' as what,
                        s.current_period_end::text as when, '/admin/customers/' || s.org_id as href
                   from app.subscriptions s join app.organizations o on o.id = s.org_id
                   join app.plan_versions pv on pv.id = s.plan_version_id join app.plans p on p.id = pv.plan_id
                  where s.status = 'active' and s.current_period_end between now() and now() + interval '7 days'
                  order by s.current_period_end`),
    q<WeekItem>(`select c.org_id, o.name as customer,
                        b.available || ' unused credit(s) roll over or expire at period end' as what,
                        c.period_end::text as when, '/admin/customers/' || c.org_id as href
                   from app.entitlement_cycles c join app.cycle_balances b on b.cycle_id = c.id
                   join app.organizations o on o.id = c.org_id
                  where c.status = 'open' and b.available > 0 and c.period_end between now() and now() + interval '7 days'`),
  ]);
  return {
    needsYou: [...review, ...failedJobs, ...failedTasks, ...badEmails, ...needsAdmin, ...stuck],
    waiting: [...onboarding, ...profiles, ...topics, ...delivered],
    comingUp: [...renewals, ...ending],
  };
}
