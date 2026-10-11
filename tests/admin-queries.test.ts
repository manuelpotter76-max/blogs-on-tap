import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase } from "./helpers/psql-db";
import { storeBillingEvent, processPendingBillingEvents } from "../src/lib/zoho/billing-events";
import { listCustomers, getCustomer, adjustCredits, recordAdminView } from "../src/lib/admin/queries";

const db = freshDatabase("bot_admin_queries_test");
after(() => db.close());
let orgId = "";
let cycleId = "";

test("setup: one Growth customer via a billing event", async () => {
  await storeBillingEvent(db, {
    event_id: "e1", event_type: "subscription_created", event_time: "2026-10-10T20:00:00Z",
    data: { subscription: {
      subscription_id: "s1", status: "live", plan: { plan_code: "growth" },
      customer: { customer_id: "c1", display_name: "Ybor Bakery", email: "owner@yborbakery.test" },
      current_term_starts_at: "2026-10-10", current_term_ends_at: "2026-11-10",
    } },
  });
  await processPendingBillingEvents(db);
});

test("customer list shows name, email, plan, status and credits left", async () => {
  const rows = await listCustomers(db);
  assert.equal(rows.length, 1);
  const r = rows[0];
  orgId = r.org_id;
  assert.equal(r.name, "Ybor Bakery");
  assert.equal(r.email, "owner@yborbakery.test");
  assert.equal(r.plan, "Growth");
  assert.equal(r.status, "active");
  assert.equal(r.credits_left, 4);
});

test("customer detail has subscription, cycle, ledger and activity", async () => {
  const d = await getCustomer(db, orgId);
  assert.ok(d);
  if (!d) return;
  assert.equal(d.subscriptions[0].plan, "Growth");
  assert.equal(d.cycles.length, 1);
  cycleId = d.cycles[0].cycle_id;
  assert.deepEqual(d.ledger.map((l) => l.kind), ["grant"]);
  assert.ok(d.activity.some((a) => a.action === "onboarding.pending"));
  assert.equal(await getCustomer(db, "00000000-0000-0000-0000-000000000000"), null);
});

test("credit adjustments validate input and are audited", async () => {
  const admin = "11111111-1111-1111-1111-111111111111";
  assert.equal(await adjustCredits(db, admin, orgId, cycleId, 0, "nothing at all"), "bad_input");
  assert.equal(await adjustCredits(db, admin, orgId, cycleId, 50, "way too many credits"), "bad_input");
  assert.equal(await adjustCredits(db, admin, orgId, cycleId, 1, "no"), "bad_input", "reason required");
  assert.equal(await adjustCredits(db, admin, orgId, cycleId, -9, "take too many away"), "would_go_negative");
  assert.equal(await adjustCredits(db, admin, "00000000-0000-0000-0000-000000000000", cycleId, 1, "wrong customer"), "not_found");
  assert.equal(await adjustCredits(db, admin, orgId, cycleId, 1, "Goodwill: late delivery in October"), "ok");

  assert.equal((await listCustomers(db))[0].credits_left, 5);
  await recordAdminView(db, admin, orgId);
  const d = await getCustomer(db, orgId);
  assert.equal(d?.ledger[0].kind, "adjust");
  assert.equal(d?.ledger[0].actor, `admin:${admin}`);
  assert.ok(d?.activity.some((a) => a.action === "credits.adjust"));
  assert.ok(d?.activity.some((a) => a.action === "admin.view_customer"));
});
