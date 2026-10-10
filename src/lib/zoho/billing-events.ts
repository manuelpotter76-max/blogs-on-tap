import type { Db, Queryable } from "../db/client";

/**
 * Turns verified Zoho Billing webhooks into subscription state and credits.
 *
 * Flow: the webhook route stores each event once (unique on event_id), then
 * processPendingBillingEvents() applies them in order. Every step is
 * idempotent, so a replayed or duplicated webhook changes nothing
 * (acceptance test 2).
 *
 * ASSUMED payload shape (Zoho Billing default webhook JSON). Verify against a
 * real test event in M2 before going live:
 *   { event_id, event_type, event_time,
 *     data: { subscription: { subscription_id, status, plan: { plan_code },
 *             customer: { customer_id, display_name, email },
 *             current_term_starts_at, current_term_ends_at } } }
 */

export type ZohoEvent = {
  event_id: string;
  event_type: string;
  event_time?: string;
  data?: { subscription?: ZohoSubscription };
};

type ZohoSubscription = {
  subscription_id: string;
  status: string;
  plan?: { plan_code?: string };
  customer?: { customer_id?: string; display_name?: string; company_name?: string; email?: string };
  current_term_starts_at?: string;
  current_term_ends_at?: string;
};

type InternalStatus =
  | "pending_payment" | "active" | "past_due" | "suspended" | "cancel_scheduled" | "cancelled";

// Zoho subscription status -> our status.
const STATUS_MAP: Record<string, InternalStatus> = {
  future: "pending_payment",
  trial: "active",
  live: "active",
  non_renewing: "cancel_scheduled",
  unpaid: "past_due",
  dunning: "past_due",
  paused: "suspended",
  cancelled: "cancelled",
  expired: "cancelled",
  creation_failed: "cancelled",
};

// Events that mean "this term is paid": grant the term's credits (idempotent per term).
// Names to confirm against the event list in Zoho Billing > Settings > Webhooks in M2.
// A grant also requires the subscription status to map to "active".
const GRANT_EVENTS = new Set([
  "subscription_created",
  "subscription_activation",
  "subscription_renewed",
  "subscription_reactivated",
  "subscription_upgraded",
]);

export const GRACE_DAYS = 7;

export async function storeBillingEvent(db: Db, event: ZohoEvent): Promise<"stored" | "duplicate"> {
  if (!event?.event_id || !event?.event_type) throw new Error("event_id and event_type are required");
  const { rows } = await db.query<{ id: string }>(
    `insert into app.billing_events (provider, provider_event_id, event_type, payload)
     values ('zoho_billing', $1, $2, $3)
     on conflict (provider, provider_event_id) do nothing
     returning id`,
    [event.event_id, event.event_type, JSON.stringify(event)],
  );
  return rows.length ? "stored" : "duplicate";
}

export async function processPendingBillingEvents(db: Db, limit = 50): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `select id from app.billing_events
      where processed_at is null and attempts < 5
      order by received_at limit $1`,
    [limit],
  );
  let processed = 0;
  for (const { id } of rows) {
    try {
      await db.transaction(async (tx) => {
        const { rows: locked } = await tx.query<{ payload: ZohoEvent; processed_at: string | null }>(
          `select payload, processed_at from app.billing_events where id = $1 for update skip locked`,
          [id],
        );
        if (!locked.length || locked[0].processed_at) return; // another tick has it
        const payload = typeof locked[0].payload === "string" ? JSON.parse(locked[0].payload) : locked[0].payload;
        await applyEvent(tx, payload);
        await tx.query(`update app.billing_events set processed_at = now(), attempts = attempts + 1 where id = $1`, [id]);
      });
      processed++;
    } catch (err) {
      await db.query(
        `update app.billing_events set attempts = attempts + 1, last_error = $2 where id = $1`,
        [id, String((err as Error).message ?? err).slice(0, 2000)],
      );
    }
  }
  return processed;
}

async function applyEvent(tx: Queryable, event: ZohoEvent): Promise<void> {
  const zsub = event.data?.subscription;
  if (!zsub?.subscription_id) {
    await audit(tx, null, "billing.event_ignored", event.event_id, { event_type: event.event_type });
    return;
  }

  const status = STATUS_MAP[zsub.status];
  if (!status) throw new Error(`Unknown Zoho subscription status "${zsub.status}"`);

  const planVersionId = await findPlanVersion(tx, zsub.plan?.plan_code);
  const eventTime = event.event_time ?? new Date().toISOString();
  let sub = await findSubscription(tx, zsub.subscription_id);

  if (!sub) {
    const orgId = await createCustomer(tx, zsub);
    const { rows } = await tx.query<SubRow>(
      `insert into app.subscriptions
         (org_id, plan_version_id, status, current_period_start, current_period_end,
          zoho_subscription_id, zoho_customer_id, last_event_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, org_id, plan_version_id, status, last_event_at`,
      [orgId, planVersionId, status, zsub.current_term_starts_at ?? null, zsub.current_term_ends_at ?? null,
       zsub.subscription_id, zsub.customer?.customer_id ?? null, eventTime],
    );
    sub = rows[0];
    await tx.query(
      `insert into app.external_ids (provider, kind, external_id, org_id, internal_id)
       values ('zoho_billing', 'subscription', $1, $2, $3) on conflict do nothing`,
      [zsub.subscription_id, orgId, sub.id],
    );
    // Phase 3 picks this up and sends the onboarding link exactly once.
    await audit(tx, orgId, "onboarding.pending", sub.id, {});
  } else if (sub.last_event_at && new Date(eventTime) < new Date(sub.last_event_at)) {
    // Out-of-order delivery: an older event must not roll state backwards.
    await audit(tx, sub.org_id, "billing.event_stale", event.event_id, { event_type: event.event_type });
    return;
  } else {
    const upgradedFrom = sub.plan_version_id !== planVersionId ? sub.plan_version_id : null;
    await tx.query(
      `update app.subscriptions
          set status = $2, plan_version_id = $3,
              current_period_start = coalesce($4, current_period_start),
              current_period_end = coalesce($5, current_period_end),
              grace_until = case
                when $2 = 'past_due' then coalesce(grace_until, now() + make_interval(days => $7))
                when $2 = 'active' then null
                else grace_until end,
              last_event_at = $6, updated_at = now()
        where id = $1`,
      [sub.id, status, planVersionId, zsub.current_term_starts_at ?? null, zsub.current_term_ends_at ?? null,
       eventTime, GRACE_DAYS],
    );
    if (upgradedFrom) await applyMidCycleUpgrade(tx, sub.id, upgradedFrom, planVersionId);
  }

  if (status === "active" && GRANT_EVENTS.has(event.event_type) &&
      zsub.current_term_starts_at && zsub.current_term_ends_at) {
    await openPaidCycle(tx, sub.id, zsub.current_term_starts_at, zsub.current_term_ends_at);
  }

  await audit(tx, sub.org_id, `billing.${event.event_type}`, sub.id, { zoho_status: zsub.status, status });
}

/** Grant the new term once, then roll over or expire the previous term's leftovers. */
async function openPaidCycle(tx: Queryable, subId: string, start: string, end: string) {
  const { rows } = await tx.query<{ cycle: string }>(
    `select app.grant_cycle($1, $2::timestamptz, $3::timestamptz) as cycle`, [subId, start, end]);
  const newCycle = rows[0].cycle;

  const { rows: prev } = await tx.query<{ id: string; rollover_cycles: number }>(
    `select c.id, pv.rollover_cycles
       from app.entitlement_cycles c
       join app.subscriptions s on s.id = c.subscription_id
       join app.plan_versions pv on pv.id = s.plan_version_id
      where c.subscription_id = $1 and c.id <> $2 and c.status <> 'closed'
        and c.period_start < $3::timestamptz`,
    [subId, newCycle, start],
  );
  for (const p of prev) {
    await tx.query(`select app.close_cycle($1, $2, $3)`, [p.id, newCycle, p.rollover_cycles > 0]);
  }
}

/** Upgrades take effect now: top the open cycle up to the new allowance. Downgrades wait for renewal. */
async function applyMidCycleUpgrade(tx: Queryable, subId: string, fromPv: string, toPv: string) {
  const { rows } = await tx.query<{ old_n: number; new_n: number; cycle_id: string | null }>(
    `select (select articles_per_cycle from app.plan_versions where id = $2) as old_n,
            (select articles_per_cycle from app.plan_versions where id = $3) as new_n,
            (select id from app.entitlement_cycles where subscription_id = $1 and status = 'open'
              order by period_start desc limit 1) as cycle_id`,
    [subId, fromPv, toPv],
  );
  const r = rows[0];
  if (r.cycle_id && r.new_n > r.old_n) {
    await tx.query(`select app.adjust_credits($1, $2, $3, 'system')`,
      [r.cycle_id, r.new_n - r.old_n, "mid-cycle upgrade"]);
  }
}

type SubRow = { id: string; org_id: string; plan_version_id: string; status: string; last_event_at: string | null };

async function findSubscription(tx: Queryable, zohoSubId: string): Promise<SubRow | undefined> {
  const { rows } = await tx.query<SubRow>(
    `select id, org_id, plan_version_id, status, last_event_at
       from app.subscriptions where zoho_subscription_id = $1 for update`, [zohoSubId]);
  return rows[0];
}

async function findPlanVersion(tx: Queryable, planCode: string | undefined): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `select id from app.plan_versions where zoho_plan_code = $1 and effective_from <= now()
      order by effective_from desc limit 1`, [planCode ?? ""]);
  if (!rows.length) throw new Error(`No plan mapped to Zoho plan code "${planCode}"`);
  return rows[0].id;
}

async function createCustomer(tx: Queryable, zsub: ZohoSubscription): Promise<string> {
  const c = zsub.customer ?? {};
  const name = c.company_name || c.display_name || "New customer";
  const { rows } = await tx.query<{ id: string }>(
    `insert into app.organizations (name) values ($1) returning id`, [name]);
  const orgId = rows[0].id;
  if (c.email) {
    const { rows: u } = await tx.query<{ id: string }>(
      `insert into app.users (email, full_name) values ($1, $2)
       on conflict (lower(email)) do update set full_name = coalesce(app.users.full_name, excluded.full_name)
       returning id`, [c.email, c.display_name ?? null]);
    await tx.query(`insert into app.memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [orgId, u[0].id]);
  }
  if (c.customer_id) {
    await tx.query(
      `insert into app.external_ids (provider, kind, external_id, org_id, internal_id)
       values ('zoho_billing', 'customer', $1, $2, $2) on conflict do nothing`, [c.customer_id, orgId]);
  }
  return orgId;
}

async function audit(tx: Queryable, orgId: string | null, action: string, target: string, details: object) {
  await tx.query(
    `insert into app.audit_events (org_id, actor, action, target, details) values ($1, 'system', $2, $3, $4)`,
    [orgId, action, target, JSON.stringify(details)]);
}
