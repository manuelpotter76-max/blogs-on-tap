import type { Db } from "../db/client";

export type CustomerRow = {
  org_id: string;
  name: string;
  email: string | null;
  plan: string | null;
  status: string | null;
  credits_left: number | null;
  period_end: string | null;
  created_at: string;
};

/** One row per customer: their latest subscription and current open cycle. */
export async function listCustomers(db: Db): Promise<CustomerRow[]> {
  const { rows } = await db.query<CustomerRow>(`
    select o.id as org_id, o.name,
           (select u.email from app.memberships m join app.users u on u.id = m.user_id
             where m.org_id = o.id order by m.created_at limit 1) as email,
           p.name as plan, s.status,
           (select b.available from app.cycle_balances b
             where b.subscription_id = s.id and b.status = 'open'
             order by b.period_start desc limit 1) as credits_left,
           s.current_period_end as period_end,
           o.created_at
      from app.organizations o
      left join lateral (
        select * from app.subscriptions s2 where s2.org_id = o.id order by s2.created_at desc limit 1
      ) s on true
      left join app.plan_versions pv on pv.id = s.plan_version_id
      left join app.plans p on p.id = pv.plan_id
     where o.status <> 'archived'
     order by o.created_at desc`);
  return rows;
}

export type CustomerDetail = {
  org: { id: string; name: string; status: string; created_at: string };
  people: { email: string; full_name: string | null; role: string }[];
  subscriptions: {
    id: string; plan: string; price_cents: number; articles_per_cycle: number; status: string;
    current_period_start: string | null; current_period_end: string | null; grace_until: string | null;
    zoho_subscription_id: string;
  }[];
  cycles: { cycle_id: string; subscription_id: string; period_start: string; period_end: string; status: string; available: number }[];
  ledger: { created_at: string; kind: string; delta: number; reason: string | null; actor: string; cycle_id: string }[];
  activity: { created_at: string; actor: string; action: string; details: unknown }[];
};

export async function getCustomer(db: Db, orgId: string): Promise<CustomerDetail | null> {
  const org = (await db.query<CustomerDetail["org"]>(
    `select id, name, status, created_at from app.organizations where id = $1`, [orgId])).rows[0];
  if (!org) return null;

  const [people, subscriptions, cycles, ledger, activity] = await Promise.all([
    db.query<CustomerDetail["people"][number]>(
      `select u.email, u.full_name, m.role from app.memberships m join app.users u on u.id = m.user_id
        where m.org_id = $1 order by m.created_at`, [orgId]),
    db.query<CustomerDetail["subscriptions"][number]>(
      `select s.id, p.name as plan, pv.price_cents, pv.articles_per_cycle, s.status, s.current_period_start,
              s.current_period_end, s.grace_until, s.zoho_subscription_id
         from app.subscriptions s
         join app.plan_versions pv on pv.id = s.plan_version_id
         join app.plans p on p.id = pv.plan_id
        where s.org_id = $1 order by s.created_at desc`, [orgId]),
    db.query<CustomerDetail["cycles"][number]>(
      `select cycle_id, subscription_id, period_start, period_end, status, available
         from app.cycle_balances where org_id = $1 order by period_start desc`, [orgId]),
    db.query<CustomerDetail["ledger"][number]>(
      `select created_at, kind, delta, reason, actor, cycle_id from app.entitlement_ledger
        where org_id = $1 order by id desc limit 100`, [orgId]),
    db.query<CustomerDetail["activity"][number]>(
      `select created_at, actor, action, details from app.audit_events
        where org_id = $1 order by id desc limit 100`, [orgId]),
  ]);

  return {
    org,
    people: people.rows,
    subscriptions: subscriptions.rows,
    cycles: cycles.rows,
    ledger: ledger.rows,
    activity: activity.rows,
  };
}

export async function recordAdminView(db: Db, adminId: string, orgId: string) {
  await db.query(`insert into app.audit_events (org_id, actor, action) values ($1, $2, 'admin.view_customer')`,
    [orgId, `admin:${adminId}`]);
}

/**
 * Admin credit correction. Checks the cycle belongs to the customer, keeps
 * changes small and requires a reason; app.adjust_credits writes the ledger
 * row and the audit event together.
 */
export async function adjustCredits(
  db: Db, adminId: string, orgId: string, cycleId: string, delta: number, reason: string,
): Promise<"ok" | "bad_input" | "not_found" | "would_go_negative"> {
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 20) return "bad_input";
  if (reason.trim().length < 5) return "bad_input";
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ available: number }>(
      `select available from app.cycle_balances where cycle_id = $1 and org_id = $2`, [cycleId, orgId]);
    if (!rows[0]) return "not_found" as const;
    if (rows[0].available + delta < 0) return "would_go_negative" as const;
    await tx.query(`select app.adjust_credits($1, $2, $3, $4)`, [cycleId, delta, reason.trim(), `admin:${adminId}`]);
    return "ok" as const;
  });
}
