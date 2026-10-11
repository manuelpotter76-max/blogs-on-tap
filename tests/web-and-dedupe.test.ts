import { test } from "node:test";
import assert from "node:assert/strict";
import { checkUrl, discoverLinks, htmlToText, isPublicAddress, robotsAllows, safeFetch, UnsafeUrlError } from "../src/lib/web/fetch-site";
import { filterFresh, similarity, topicKey } from "../src/lib/agents/dedupe";
import { validate } from "../src/lib/ai/json-schema";
import { toOpenAISchema } from "../src/lib/ai/openai";
import { PROFILE_SCHEMA, enforceConfirmationFlags, type BusinessProfile } from "../src/lib/agents/business-profile";
import { cleanAnswers, stepErrors, firstIncompleteStep } from "../src/lib/onboarding/questions";
import { checkUpload } from "../src/lib/uploads/storage";

test("SSRF: private, local and odd URLs are refused before any request", () => {
  for (const bad of ["ftp://x.com", "http://127.0.0.1/", "http://10.1.2.3/", "http://169.254.169.254/latest/meta-data",
    "http://[::1]/", "http://[::ffff:192.168.1.1]/", "http://localhost/", "http://db.internal/", "https://x.com:8443/",
    "https://user:pw@x.com/", "javascript:alert(1)"]) {
    assert.throws(() => checkUrl(bad), UnsafeUrlError, bad);
  }
  assert.equal(checkUrl("https://example.com/about#team").toString(), "https://example.com/about");
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("100.64.0.1"), false);
  assert.equal(isPublicAddress("fd00::1"), false);
  assert.equal(isPublicAddress("2606:4700::1111"), true);
});

test("SSRF: a public hostname that resolves to a private address is refused (DNS rebinding)", async () => {
  await assert.rejects(safeFetch("https://evil.example/", async () => [{ address: "10.0.0.5", family: 4 }]), UnsafeUrlError);
  await assert.rejects(safeFetch("https://evil.example/", async () => [
    { address: "93.184.215.14", family: 4 }, { address: "127.0.0.1", family: 4 }]), UnsafeUrlError, "any private answer blocks");
});

test("robots.txt: our group wins over *, longest rule wins", () => {
  const robots = "User-agent: *\nDisallow: /\n\nUser-agent: BlogsOnTapBot\nDisallow: /private\nAllow: /private/ok\n";
  assert.equal(robotsAllows(robots, "/about"), true);
  assert.equal(robotsAllows(robots, "/private/x"), false);
  assert.equal(robotsAllows(robots, "/private/ok/page"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /admin", "/admin/x"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow:", "/anything"), true);
  assert.equal(robotsAllows("", "/"), true);
});

test("HTML to text drops scripts and navigation, keeps headings; links stay on site", () => {
  const html = `<html><head><title>Ybor &amp; Sons</title><meta name="description" content="Plumbers"></head>
    <body><nav><a href="/x">Menu</a></nav><script>steal()</script><h1>Leak repair</h1><p>We fix&nbsp;leaks.</p>
    <a href="/about">About</a><a href="https://other.com/">Other</a><a href="/files/menu.pdf">PDF</a><a href="/services/drains?x=1">Drains</a></body></html>`;
  const t = htmlToText(html);
  assert.equal(t.title, "Ybor & Sons");
  assert.equal(t.description, "Plumbers");
  assert.match(t.text, /## Leak repair\nWe fix leaks\./);
  assert.doesNotMatch(t.text, /steal|Menu/);
  assert.deepEqual(discoverLinks(html, new URL("https://ybor.test/")),
    ["https://ybor.test/about", "https://ybor.test/services/drains", "https://ybor.test/x"]);
});

test("topic dedupe: keys, similarity and filtering", () => {
  assert.equal(topicKey("10 Ways to Fix a Leaky Faucet"), topicKey("How to fix leaky faucets"));
  assert.ok(similarity("Signs of a Hidden Slab Leak", "Hidden Slab Leak Signs to Watch") >= 0.6);
  assert.ok(similarity("Water Heater Repair or Replace", "Signs of a Hidden Slab Leak") < 0.2);
  const { kept, dropped } = filterFresh([
    { title: "Water heater repair or replace?", primary_keyword: "water heater repair" },
    { title: "Tankless water heaters explained", primary_keyword: "water heater repair" },
  ], [{ title: "Old post", primary_keyword: null }]);
  assert.equal(kept.length, 1);
  assert.match(dropped[0].reason, /same keyword/);
});

test("agent schemas: strict-mode shape and our validator agree", () => {
  const s = toOpenAISchema(PROFILE_SCHEMA) as { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> };
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required.sort(), Object.keys(s.properties).sort());
  assert.ok(validate(PROFILE_SCHEMA, { business_name: "x" }).length > 0);
  assert.deepEqual(validate({ type: "array", items: { type: "string" }, maxItems: 1 }, ["a", "b"]), ["$: more than 1 items"]);
  assert.deepEqual(validate({ type: ["string", "null"] }, null), []);
});

test("confirmation flags: the model can't mark its own inferences as confirmed", () => {
  const p = enforceConfirmationFlags({
    services: [{ name: "A", description: "", priority: false, source: "website: https://x", needs_confirmation: false },
               { name: "B", description: "", priority: false, source: "customer", needs_confirmation: false }],
    audience: [], pain_points: [], differentiators: [], facts: [{ text: "x", source: "", needs_confirmation: false }],
  } as unknown as BusinessProfile);
  assert.deepEqual(p.services.map((s) => s.needs_confirmation), [true, false]);
  assert.deepEqual(p.facts[0], { text: "x", source: "unknown", needs_confirmation: true });
});

test("questionnaire: hidden fields drop out, required depends on visibility", () => {
  const a = cleanAnswers({ business_name: "  X  ", service_area_type: "online", service_area: "Tampa",
    services: "a\n\n b ", tone: ["friendly", "bogus"], regulated: "none", compliance_notes: "hide me", evil: "x" });
  assert.equal(a.business_name, "X");
  assert.equal(a.service_area, undefined, "hidden when online");
  assert.equal(a.compliance_notes, undefined);
  assert.equal(a.evil, undefined);
  assert.deepEqual(a.services, ["a", "b"]);
  assert.deepEqual(a.tone, ["friendly"]);
  assert.equal(stepErrors(0, cleanAnswers({ service_area_type: "local" })).service_area, "This one's needed.");
  assert.equal(stepErrors(0, cleanAnswers({ website: "not a url" })).website, "Use a full address starting with https://");
  assert.equal(firstIncompleteStep({}), 0);
});

test("upload checks go by content", () => {
  assert.equal(checkUpload("a.txt", new Uint8Array([104, 0, 105])).ok, false, "binary in a .txt");
  assert.equal(checkUpload("a.txt", new Uint8Array([0xff, 0xfe])).ok, false, "not UTF-8");
  assert.equal(checkUpload("a.md", new TextEncoder().encode("# Brand")).ok, true);
  assert.equal(checkUpload("a.pdf", new Uint8Array(5 * 1024 * 1024)).ok, false, "too big");
});
