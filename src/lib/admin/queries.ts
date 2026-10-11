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

export type DetailsResult = "ok" | "bad_input" | "bad_email" | "email_taken" | "not_found" | "unchanged";

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i;

/**
 * Admin edit of a customer's business name, contact name and email.
 * - Business name also goes into the business profile, so new articles use it.
 * - Email changes the owner's login/notification address. If the owner is also
 *   on another customer's account, or has no account yet, a separate person
 *   record is used so the other customer isn't changed by accident.
 * Billing (Zoho) is not touched; invoices keep going to the address in Zoho.
 */
export async function updateCustomerDetails(
  db: Db, adminId: string, orgId: string,
  input: { businessName: string; contactName: string; email: string },
): Promise<DetailsResult> {
  const businessName = input.businessName.trim().replace(/\s+/g, " ");
  const contactName = input.contactName.trim().replace(/\s+/g, " ");
  const email = input.email.trim().toLowerCase();
  if (businessName.length < 2 || businessName.length > 120 || contactName.length > 120) return "bad_input";
  if (email.length > 254 || !EMAIL.test(email)) return "bad_email";
  const actor = `admin:${adminId}`;

  return db.transaction(async (tx) => {
    const org = (await tx.query<{ name: string }>(
      `select name from app.organizations where id = $1 for update`, [orgId])).rows[0];
    if (!org) return "not_found" as const;
    const owner = (await tx.query<{ user_id: string; email: string; full_name: string | null; orgs: number }>(
      `select u.id as user_id, u.email, u.full_name,
              (select count(*)::int from app.memberships m2 where m2.user_id = u.id) as orgs
         from app.memberships m join app.users u on u.id = m.user_id
        where m.org_id = $1 order by (m.role = 'owner') desc, m.created_at limit 1 for update of u`, [orgId])).rows[0];

    const changes: Record<string, { from: string | null; to: string }> = {};

    if (businessName !== org.name) {
      await tx.query(`update app.organizations set name = $2 where id = $1`, [orgId, businessName]);
      changes.business_name = { from: org.name, to: businessName };
      // Keep the business profile in step so new articles use the new name.
      const prof = (await tx.query<{ version: number; data: Record<string, unknown> }>(
        `select pv.version, pv.data from app.business_profiles bp
           join app.profile_versions pv on pv.org_id = bp.org_id and pv.version = bp.current_version
          where bp.org_id = $1 for update of bp`, [orgId])).rows[0];
      if (prof && prof.data.business_name !== businessName) {
        const version = prof.version + 1;
        await tx.query(
          `insert into app.profile_versions (org_id, version, data, created_by) values ($1, $2, $3, $4)`,
          [orgId, version, JSON.stringify({ ...prof.data, business_name: businessName }), actor]);
        await tx.query(`update app.business_profiles set current_version = $2, updated_at = now() where org_id = $1`,
          [orgId, version]);
      }
    }

    const emailChanged = !owner || owner.email.toLowerCase() !== email;
    const nameChanged = (owner?.full_name ?? "") !== contactName;
    if (emailChanged || nameChanged) {
      const other = emailChanged ? (await tx.query<{ id: string }>(
        `select id from app.users where lower(email) = $1`, [email])).rows[0] : undefined;
      if (other) {
        // Someone else already uses this address. Allow it only if they aren't tied to a different customer.
        const elsewhere = (await tx.query<{ n: number }>(
          `select count(*)::int as n from app.memberships where user_id = $1 and org_id <> $2`, [other.id, orgId])).rows[0].n;
        if (elsewhere > 0) return "email_taken" as const;
      }
      if (owner && !other && owner.orgs === 1) {
        // The simple case: this person only belongs to this customer. Change them in place.
        await tx.query(`update app.users set email = $2, full_name = nullif($3, '') where id = $1`,
          [owner.user_id, email, contactName]);
      } else {
        // Point this customer at a person record for the new address (new, or an unattached existing one).
        const userId = other?.id ?? (await tx.query<{ id: string }>(
          `insert into app.users (email, full_name) values ($1, nullif($2, '')) returning id`, [email, contactName])).rows[0].id;
        if (other) await tx.query(`update app.users set full_name = nullif($2, '') where id = $1`, [userId, contactName]);
        if (owner) await tx.query(`delete from app.memberships where org_id = $1 and user_id = $2`, [orgId, owner.user_id]);
        await tx.query(
          `insert into app.memberships (org_id, user_id, role) values ($1, $2, 'owner')
           on conflict (org_id, user_id) do update set role = 'owner'`, [orgId, userId]);
      }
      if (emailChanged) changes.email = { from: owner?.email ?? null, to: email };
      if (nameChanged) changes.contact_name = { from: owner?.full_name ?? null, to: contactName };
    }

    if (Object.keys(changes).length === 0) return "unchanged" as const;
    await tx.query(
      `insert into app.audit_events (org_id, actor, action, target, details) values ($1, $2, 'customer.details_updated', $3, $4)`,
      [orgId, actor, orgId, JSON.stringify(changes)]);
    return "ok" as const;
  });
}
