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

// ---- Editing name, business name and email ----
import { updateCustomerDetails } from "../src/lib/admin/queries";

const owner = async (org: string) => (await db.query<{ email: string; full_name: string | null }>(
  `select u.email, u.full_name from app.memberships m join app.users u on u.id = m.user_id where m.org_id = $1`, [org])).rows;

test("details: rename the business and change the contact in place; profile follows", async () => {
  await db.query(`insert into app.profile_versions (org_id, version, data, created_by) values ($1, 1, '{"business_name":"Ybor Bakery","summary":"x"}', 'ai')`, [orgId]);
  await db.query(`insert into app.business_profiles (org_id, status, current_version) values ($1, 'confirmed', 1)`, [orgId]);
  const r = await updateCustomerDetails(db, "00000000-0000-0000-0000-000000000001", orgId,
    { businessName: "  Ybor  Bakery & Cafe ", contactName: "Rosa Diaz", email: "Rosa@YborBakery.test" });
  assert.equal(r, "ok");
  assert.equal((await db.query<{ name: string }>(`select name from app.organizations where id = $1`, [orgId])).rows[0].name, "Ybor Bakery & Cafe");
  assert.deepEqual(await owner(orgId), [{ email: "rosa@yborbakery.test", full_name: "Rosa Diaz" }]);
  const p = (await db.query<{ data: { business_name: string; summary: string }; created_by: string }>(
    `select pv.data, pv.created_by from app.business_profiles bp join app.profile_versions pv
      on pv.org_id = bp.org_id and pv.version = bp.current_version where bp.org_id = $1`, [orgId])).rows[0];
  assert.equal(p.data.business_name, "Ybor Bakery & Cafe");
  assert.equal(p.data.summary, "x", "the rest of the profile is untouched");
  assert.ok(p.created_by.startsWith("admin:"));
  const a = (await db.query<{ details: { email: { from: string; to: string } } }>(
    `select details from app.audit_events where org_id = $1 and action = 'customer.details_updated'`, [orgId])).rows[0];
  assert.equal(a.details.email.from, "owner@yborbakery.test");
  assert.equal((await listCustomers(db))[0].email, "rosa@yborbakery.test", "customer list shows the new email");
});

test("details: no-op, bad input and bad email are refused cleanly", async () => {
  const admin = "00000000-0000-0000-0000-000000000001";
  assert.equal(await updateCustomerDetails(db, admin, orgId, { businessName: "Ybor Bakery & Cafe", contactName: "Rosa Diaz", email: "rosa@yborbakery.test" }), "unchanged");
  assert.equal(await updateCustomerDetails(db, admin, orgId, { businessName: "Y", contactName: "", email: "a@b.co" }), "bad_input");
  assert.equal(await updateCustomerDetails(db, admin, orgId, { businessName: "Ybor Bakery", contactName: "", email: "not an email" }), "bad_email");
  assert.equal(await updateCustomerDetails(db, admin, "00000000-0000-0000-0000-00000000dead", { businessName: "Ybor Bakery", contactName: "", email: "a@b.co" }), "not_found");
});

test("details: another customer's email is refused; a person shared by two customers isn't changed for both", async () => {
  const admin = "00000000-0000-0000-0000-000000000001";
  const other = (await db.query<{ id: string }>(`insert into app.organizations (name) values ('Cigar Shop') returning id`)).rows[0].id;
  const u = (await db.query<{ id: string }>(`insert into app.users (email, full_name) values ('cigars@shop.test', 'Sal') returning id`)).rows[0].id;
  await db.query(`insert into app.memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [other, u]);
  assert.equal(await updateCustomerDetails(db, admin, orgId, { businessName: "Ybor Bakery & Cafe", contactName: "Rosa Diaz", email: "CIGARS@shop.test" }), "email_taken");

  // Sal also owns a second business. Changing that one's email must not change the Cigar Shop's.
  const third = (await db.query<{ id: string }>(`insert into app.organizations (name) values ('Sal''s Lounge') returning id`)).rows[0].id;
  await db.query(`insert into app.memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [third, u]);
  assert.equal(await updateCustomerDetails(db, admin, third, { businessName: "Sal's Lounge", contactName: "Sal", email: "lounge@shop.test" }), "ok");
  assert.deepEqual(await owner(third), [{ email: "lounge@shop.test", full_name: "Sal" }]);
  assert.deepEqual(await owner(other), [{ email: "cigars@shop.test", full_name: "Sal" }]);
});
