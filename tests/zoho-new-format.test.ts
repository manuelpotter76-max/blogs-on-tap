import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase } from "./helpers/psql-db";
import {
  normalizeZohoPayload,
  storeBillingEvent,
  processPendingBillingEvents,
  STATE_SNAPSHOT_EVENT,
} from "../src/lib/zoho/billing-events";

const db = freshDatabase("bot_newformat_test");
after(() => db.close());

function newFormatBody(status: string, updated: string) {
  return JSON.stringify({
    subscription: {
      subscription_id: "sub_NEW",
      status,
      created_time: "2026-10-10T20:00:00-0400",
      updated_time: updated,
      plan: { plan_code: "premium" },
      customer: { customer_id: "cust_NEW", display_name: "Ybor Coffee", email: "hello@yborcoffee.test" },
      current_term_starts_at: "2026-10-10",
      current_term_ends_at: "2026-11-10",
    },
  });
}

async function send(rawBody: string) {
  const event = await normalizeZohoPayload(JSON.parse(rawBody), rawBody);
  const stored = await storeBillingEvent(db, event);
  await processPendingBillingEvents(db);
  return { event, stored };
}

test("previous format passes through with its own event id", async () => {
  const body = { event_id: 123, event_type: "subscription_created", data: { subscription: { subscription_id: "x", status: "live" } } };
  const e = await normalizeZohoPayload(body, JSON.stringify(body));
  assert.equal(e.event_id, "123");
  assert.equal(e.event_type, "subscription_created");
});

test("garbage payload is rejected", async () => {
  await assert.rejects(normalizeZohoPayload({ hello: "world" }, '{"hello":"world"}'), /Unrecognized/);
});

test("newer format: a live subscription creates the customer and grants Premium's 8 credits", async () => {
  const { event, stored } = await send(newFormatBody("live", "2026-10-10T20:01:00-0400"));
  assert.equal(event.event_type, STATE_SNAPSHOT_EVENT);
  assert.match(event.event_id, /^body:[0-9a-f]{64}$/);
  assert.equal(stored, "stored");

  const r = (await db.query<{ name: string; status: string; available: number }>(
    `select o.name, s.status, b.available
       from app.subscriptions s
       join app.organizations o on o.id = s.org_id
       join app.cycle_balances b on b.subscription_id = s.id
      where s.zoho_subscription_id = 'sub_NEW'`)).rows;
  assert.deepEqual(r, [{ name: "Ybor Coffee", status: "active", available: 8 }]);
});

test("newer format: the identical body delivered again is stored once", async () => {
  const { stored } = await send(newFormatBody("live", "2026-10-10T20:01:00-0400"));
  assert.equal(stored, "duplicate");
  const n = (await db.query<{ n: number }>(`select count(*)::int as n from app.entitlement_ledger where kind = 'grant'`)).rows[0].n;
  assert.equal(n, 1);
});

test("newer format: a later unpaid snapshot moves the subscription to past due", async () => {
  await send(newFormatBody("unpaid", "2026-10-12T09:00:00-0400"));
  const s = (await db.query<{ status: string }>(
    `select status from app.subscriptions where zoho_subscription_id = 'sub_NEW'`)).rows[0];
  assert.equal(s.status, "past_due");
});

test("immediate cancellation expires leftover credits and closes the period", async () => {
  await send(newFormatBody("cancelled", "2026-10-13T09:00:00-0400"));
  const r = (await db.query<{ status: string; available: number; cycle_status: string }>(
    `select s.status, b.available, b.status as cycle_status
       from app.subscriptions s join app.cycle_balances b on b.subscription_id = s.id
      where s.zoho_subscription_id = 'sub_NEW'`)).rows;
  assert.deepEqual(r, [{ status: "cancelled", available: 0, cycle_status: "closed" }]);
  const expired = (await db.query<{ delta: number; reason: string }>(
    `select delta, reason from app.entitlement_ledger where kind = 'expire'`)).rows;
  assert.deepEqual(expired, [{ delta: -8, reason: "subscription cancelled" }]);
});
