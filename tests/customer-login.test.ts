import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase } from "./helpers/psql-db";
import { storeBillingEvent, processPendingBillingEvents, type ZohoEvent } from "../src/lib/zoho/billing-events";
import {
  completeLinkSignIn, completeLinkWithPassword, createLoginLink, createSession, endSession, inviteTeammate, listTeam,
  orgsFor, passwordProblem, peekLoginLink, removeTeammate, requestEmailLink, safeNext, sendAccountSetup, sessionFor,
  setPassword, setUpOwnerLogin, signInWithPassword, switchOrg,
} from "../src/lib/customer/auth";
import { asTenant } from "../src/lib/db/client";


process.env.LINK_SECRET = "test-link-secret-0123456789abcdef0123456789";
process.env.APP_BASE_URL = "https://app.test";
process.env.EMAIL_PROVIDER = "log";

const db = freshDatabase("bot_customer_login_test");
const realLog = console.log;
const mail: string[] = [];
before(() => { console.log = (...a: unknown[]) => { mail.push(a.join(" ")); }; });
after(() => { db.close(); console.log = realLog; });

const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const n = async (sql: string, p: unknown[] = []) => (await one<{ n: number }>(sql, p)).n;
/** The token from the last login email sent to this address. */
const lastToken = (to: string) => {
  const m = mail.filter((l) => l.includes(`to=${to}`)).at(-1)?.match(/\/login\/l\/([A-Za-z0-9_-]+)/);
  assert.ok(m, `no login link emailed to ${to}`);
  return m[1];
};

async function customer(id: string, name: string, email: string): Promise<string> {
  const e: ZohoEvent = {
    event_id: `ev_${id}`, event_type: "subscription_created", event_time: "2026-10-01T00:00:00Z",
    data: { subscription: { subscription_id: `sub_${id}`, status: "live", plan: { plan_code: "starter" },
      customer: { customer_id: `c_${id}`, display_name: name, email },
      current_term_starts_at: "2026-10-01", current_term_ends_at: "2026-11-01" } },
  } as ZohoEvent;
  await storeBillingEvent(db, e);
  await processPendingBillingEvents(db);
  return (await one<{ org_id: string }>(`select org_id from app.subscriptions where zoho_subscription_id = $1`, [`sub_${id}`])).org_id;
}

let bakery = "";
let shop = "";
let rosaToken = "";
const ADMIN = "00000000-0000-0000-0000-000000000001";
const PW = "cafe con leche 1886";

test("setup: two paying customers, each with an owner from Zoho", async () => {
  bakery = await customer("bakery", "Ybor Bakery", "rosa@bakery.test");
  shop = await customer("shop", "Cigar Shop", "sal@shop.test");
  assert.ok(bakery && shop && bakery !== shop);
});

test("password rules: 10+ characters, not common, not the email", () => {
  assert.match(passwordProblem("short", "a@b.co") ?? "", /at least 10/);
  assert.match(passwordProblem("password123", "a@b.co") ?? "", /too common/);
  assert.match(passwordProblem("aaaaaaaaaaaaaa", "a@b.co") ?? "", /too common/);
  assert.match(passwordProblem("rosa-loves-bread", "rosa@bakery.test") ?? "", /email/);
  assert.equal(passwordProblem(PW, "rosa@bakery.test"), null);
  assert.equal(safeNext("/dashboard/account"), "/dashboard/account");
  assert.equal(safeNext("//evil.example"), "/dashboard");
  assert.equal(safeNext("https://evil.example"), "/dashboard");
});

test("first-time setup from the welcome link: once, then it's a normal login", async () => {
  assert.equal((await setUpOwnerLogin(db, bakery, "short")).ok, false);
  const r = await setUpOwnerLogin(db, bakery, PW, "test-agent");
  assert.ok(r.ok);
  if (!r.ok) return;
  rosaToken = r.token;
  const s = await sessionFor(db, r.token);
  assert.deepEqual([s?.email, s?.role, s?.orgName, s?.hasPassword], ["rosa@bakery.test", "owner", "Ybor Bakery", true]);
  const again = await setUpOwnerLogin(db, bakery, "another long password");
  assert.deepEqual(again, { ok: false, reason: "already_set" }, "the welcome link can't overwrite a password");
  assert.equal(await n(`select count(*)::int n from app.audit_events where action = 'login.set_up' and org_id = $1`, [bakery]), 1);
});

test("password sign-in: right password works, wrong and unknown are the same answer", async () => {
  assert.deepEqual(await signInWithPassword(db, "rosa@bakery.test", "wrong password!!", "ip1"), { ok: false, reason: "invalid" });
  assert.deepEqual(await signInWithPassword(db, "nobody@nowhere.test", PW, "ip1"), { ok: false, reason: "invalid" });
  assert.deepEqual(await signInWithPassword(db, "sal@shop.test", PW, "ip1"), { ok: false, reason: "invalid" }, "no password set yet");
  const ok = await signInWithPassword(db, "  ROSA@bakery.test ", PW, "ip1");
  assert.ok(ok.ok, "email is case and space insensitive");
});

test("5 wrong passwords for an email pause sign-in for it, even with the right password", async () => {
  for (let i = 0; i < 5; i++) await signInWithPassword(db, "rosa@bakery.test", `wrong password ${i}`, `ip-x${i}`);
  assert.deepEqual(await signInWithPassword(db, "rosa@bakery.test", PW, "ip-other"), { ok: false, reason: "throttled" });
  await db.query(`delete from app.customer_login_attempts`);
});

test("emailed sign-in link: opening the page doesn't use it; submitting does, once", async () => {
  assert.equal(await requestEmailLink(db, "nobody@nowhere.test", "sign_in"), "skipped");
  assert.equal(await requestEmailLink(db, "sal@shop.test", "sign_in"), "sent");
  const token = lastToken("sal@shop.test");
  assert.equal((await peekLoginLink(db, token))?.purpose, "sign_in");
  assert.ok(await peekLoginLink(db, token), "peeking twice is fine (mail scanners)");
  const s = await completeLinkSignIn(db, token, "ua");
  assert.ok(s, "signs in without a password");
  assert.equal(await completeLinkSignIn(db, token, "ua"), null, "single use");
  assert.equal((await sessionFor(db, s!.token))?.orgName, "Cigar Shop");
});

test("a newer link cancels the older one, and only 3 links per 15 minutes are sent", async () => {
  await db.query(`delete from app.login_links`);
  await requestEmailLink(db, "sal@shop.test", "sign_in");
  const first = lastToken("sal@shop.test");
  await requestEmailLink(db, "sal@shop.test", "sign_in");
  const second = lastToken("sal@shop.test");
  assert.equal(await peekLoginLink(db, first), null);
  assert.ok(await peekLoginLink(db, second));
  assert.equal(await requestEmailLink(db, "sal@shop.test", "password_reset"), "sent");
  assert.equal(await requestEmailLink(db, "sal@shop.test", "sign_in"), "skipped", "fourth in 15 minutes");
});

test("an expired link doesn't work", async () => {
  const sal = await one<{ id: string }>(`select id from app.users where email = 'sal@shop.test'`);
  const l = await createLoginLink(db, sal.id, shop, "sign_in");
  await db.query(`update app.login_links set expires_at = now() - interval '1 second' where id = $1`, [l.id]);
  assert.equal(await peekLoginLink(db, l.token), null);
  assert.equal(await completeLinkSignIn(db, l.token), null);
});

test("password reset: bad password keeps the link; good password signs out other devices and emails a notice", async () => {
  const before = await signInWithPassword(db, "rosa@bakery.test", PW, "ip2");
  assert.ok(before.ok);
  await requestEmailLink(db, "rosa@bakery.test", "password_reset");
  const token = lastToken("rosa@bakery.test");
  const bad = await completeLinkWithPassword(db, token, "short");
  assert.equal(bad.ok, false);
  assert.ok(await peekLoginLink(db, token), "a rejected password doesn't burn the link");
  const good = await completeLinkWithPassword(db, token, "a brand new long password");
  assert.ok(good.ok);
  assert.equal(await sessionFor(db, before.ok ? before.token : ""), null, "old session signed out");
  assert.equal(await sessionFor(db, rosaToken), null);
  assert.ok(await sessionFor(db, good.ok ? good.token : ""), "the new session works");
  assert.equal((await completeLinkWithPassword(db, token, "yet another long password")).ok, false, "single use");
  assert.equal(await n(`select count(*)::int n from app.notifications where kind = 'login_password_changed'`), 1);
  const r = await signInWithPassword(db, "rosa@bakery.test", "a brand new long password", "ip2");
  assert.ok(r.ok);
  if (r.ok) rosaToken = r.token;
});

test("sessions: sign-out works, and expired sessions are refused", async () => {
  const sal = await one<{ id: string }>(`select id from app.users where email = 'sal@shop.test'`);
  const s = await createSession(db, sal.id, shop);
  assert.ok(await sessionFor(db, s.token));
  await endSession(db, s.token);
  assert.equal(await sessionFor(db, s.token), null);
  const t = await createSession(db, sal.id, shop);
  await db.query(`update app.customer_sessions set expires_at = now() - interval '1 second' where user_id = $1`, [sal.id]);
  assert.equal(await sessionFor(db, t.token), null);
  assert.equal(await sessionFor(db, "not-a-token"), null);
});

test("admin setup email goes to the owner until they have a login", async () => {
  assert.equal(await sendAccountSetup(db, ADMIN, shop), "sent");
  const token = lastToken("sal@shop.test");
  assert.equal((await peekLoginLink(db, token))?.purpose, "account_setup");
  const r = await completeLinkWithPassword(db, token, "humidor on seventh ave");
  assert.ok(r.ok);
  assert.equal(await sendAccountSetup(db, ADMIN, shop), "already_set");
  assert.equal(await sendAccountSetup(db, ADMIN, bakery), "already_set");
});

test("teammates: owner invites, teammate sets a login and joins; members can't invite", async () => {
  const owner = (await sessionFor(db, rosaToken))!;
  assert.equal(await inviteTeammate(db, owner, "not an email", ""), "bad_email");
  assert.equal(await inviteTeammate(db, owner, "rosa@bakery.test", ""), "already_member");
  assert.equal(await inviteTeammate(db, owner, "Ana@Bakery.test", "Ana Diaz"), "sent");
  assert.match(mail.at(-1) ?? "", /Accept the invite|invited you/);
  const team = await listTeam(db, bakery);
  assert.deepEqual(team.map((t) => [t.email, t.role, t.status]), [["rosa@bakery.test", "owner", "active"], ["ana@bakery.test", "member", "invited"]]);
  assert.deepEqual(await signInWithPassword(db, "ana@bakery.test", "anything long enough", "ip3"), { ok: false, reason: "invalid" });

  const token = lastToken("ana@bakery.test");
  const link = await peekLoginLink(db, token);
  assert.deepEqual([link?.purpose, link?.inviter, link?.orgName], ["invite", "Ybor Bakery", "Ybor Bakery"],
    "the inviter is shown by name (from Zoho), falling back to email");
  const r = await completeLinkWithPassword(db, token, "ana bakes the bread");
  assert.ok(r.ok);
  const ana = (await sessionFor(db, r.ok ? r.token : ""))!;
  assert.deepEqual([ana.role, ana.orgName], ["member", "Ybor Bakery"]);
  assert.equal((await listTeam(db, bakery))[1].status, "active");
  assert.equal(await inviteTeammate(db, ana, "x@y.test", ""), "not_owner");
  assert.equal(await removeTeammate(db, ana, owner.userId), "not_owner");
});

test("removing a teammate signs them out of that business at once", async () => {
  const owner = (await sessionFor(db, rosaToken))!;
  const ana = await signInWithPassword(db, "ana@bakery.test", "ana bakes the bread", "ip4");
  assert.ok(ana.ok);
  const anaId = (await one<{ id: string }>(`select id from app.users where email = 'ana@bakery.test'`)).id;
  assert.equal(await removeTeammate(db, owner, owner.userId), "not_found", "the owner can't remove themselves");
  assert.equal(await removeTeammate(db, owner, anaId), "ok");
  assert.equal(await sessionFor(db, ana.ok ? ana.token : ""), null);
  assert.deepEqual(await signInWithPassword(db, "ana@bakery.test", "ana bakes the bread", "ip4"), { ok: false, reason: "no_business" });
});

test("someone in two businesses can switch between them; invite with an existing login just joins", async () => {
  const owner = (await sessionFor(db, rosaToken))!;
  assert.equal(await inviteTeammate(db, owner, "sal@shop.test", "Sal"), "sent");
  const token = lastToken("sal@shop.test");
  assert.equal((await peekLoginLink(db, token))?.hasPassword, true);
  assert.equal((await completeLinkWithPassword(db, token, "whatever long enough")).ok, true,
    "they may also pick a new password from the invite");
  const sal = await signInWithPassword(db, "sal@shop.test", "whatever long enough", "ip5");
  assert.ok(sal.ok);
  if (!sal.ok) return;
  const s = (await sessionFor(db, sal.token))!;
  assert.deepEqual((await orgsFor(db, s.userId)).map((o) => o.name), ["Cigar Shop", "Ybor Bakery"]);
  const other = s.orgId === bakery ? shop : bakery;
  assert.equal(await switchOrg(db, sal.token, s.userId, other), true);
  assert.equal((await sessionFor(db, sal.token))?.orgId, other);
  const stranger = await customer("third", "Third Co", "third@co.test");
  assert.equal(await switchOrg(db, sal.token, s.userId, stranger), false, "can't switch into a business you're not in");
});

test("changing the password signs out other devices but keeps this one", async () => {
  const a = await signInWithPassword(db, "rosa@bakery.test", "a brand new long password", "ip6");
  const b = await signInWithPassword(db, "rosa@bakery.test", "a brand new long password", "ip6");
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  const s = (await sessionFor(db, a.token))!;
  await setPassword(db, s.userId, "the newest long password", a.token);
  assert.ok(await sessionFor(db, a.token));
  assert.equal(await sessionFor(db, b.token), null);
});

test("the restricted role can't read sessions, login links or review links", async () => {
  await assert.rejects(asTenant(db, bakery, (tx) => tx.query(`select count(*) from app.customer_sessions`)));
  await assert.rejects(asTenant(db, bakery, (tx) => tx.query(`select count(*) from app.login_links`)));
  await assert.rejects(asTenant(db, bakery, (tx) => tx.query(`select count(*) from app.access_links`)));
});

test("dashboard home: plan, this month, and what needs the customer, read under the restricted role", async () => {
  const { getHome } = await import("../src/lib/customer/home");
  const home = await getHome(db, bakery);
  assert.equal(home.plan?.name, "Starter");
  assert.equal(home.plan?.perMonth, 2);
  assert.deepEqual(home.month, { ready: 0, inWorks: 0, notStarted: 2 });
  assert.equal(home.needsYou[0].kind, "onboarding");
  assert.match(home.needsYou[0].href, /^https:\/\/app\.test\/start\/[0-9a-f-]+\./);
  assert.deepEqual(home.recent, []);
  const again = await getHome(db, bakery);
  assert.equal(again.needsYou[0].href, home.needsYou[0].href, "reuses the same live link instead of making new ones");
});

test("admin This week lists customers past onboarding who never set up a login", async () => {
  const { getWeek } = await import("../src/lib/admin/week");
  const third = (await one<{ org_id: string }>(`select org_id from app.subscriptions where zoho_subscription_id = 'sub_third'`)).org_id;
  await db.query(`insert into app.onboarding_responses (org_id, answers, submitted_at) values ($1, '{}', now())`, [third]);
  const w = await getWeek(db);
  const rows = w.waiting.filter((i) => i.what === "Hasn't set up a dashboard login");
  assert.deepEqual(rows.map((r) => r.org_id), [third], "bakery and shop have logins; third doesn't");
});

test("if the email service refuses a login email, nothing crashes: admin gets a clear result, sign-in pages stay calm", async () => {
  const third = (await one<{ org_id: string }>(`select org_id from app.subscriptions where zoho_subscription_id = 'sub_third'`)).org_id;
  const env = { ...process.env };
  const realFetch = globalThis.fetch;
  const realErr = console.error;
  process.env.EMAIL_PROVIDER = "zeptomail";
  process.env.ZEPTOMAIL_TOKEN = "test";
  process.env.EMAIL_FROM = "get@blogsontap.test";
  globalThis.fetch = (async () => new Response('{"error":{"message":"Sender address not verified"}}', { status: 401 })) as typeof fetch;
  console.error = () => {};
  try {
    assert.equal(await sendAccountSetup(db, ADMIN, third), "email_failed");
    assert.equal(await n(`select count(*)::int n from app.login_links l join app.users u on u.id = l.user_id
                          where u.email = 'third@co.test' and l.used_at is null`), 0, "the undelivered link is retired");
    assert.equal(await requestEmailLink(db, "rosa@bakery.test", "sign_in"), "skipped");
    const signed = await signInWithPassword(db, "rosa@bakery.test", "the newest long password", "ip9");
    assert.ok(signed.ok);
    const owner = (await sessionFor(db, signed.ok ? signed.token : ""))!;
    assert.equal(await inviteTeammate(db, owner, "late@bakery.test", ""), "email_failed");
  } finally {
    process.env = env;
    globalThis.fetch = realFetch;
    console.error = realErr;
  }
});
