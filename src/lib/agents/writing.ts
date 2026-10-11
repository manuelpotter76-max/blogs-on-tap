import { arr, bool, int, obj, oneOf, str, type Schema } from "@/lib/ai/json-schema";
import type { BusinessProfile } from "./business-profile";
import { ARTICLE_SCHEMA, type ArticleContent } from "@/lib/articles/content";

/**
 * Agents for Phase 4. Bump a PROMPT_VERSION whenever its instructions change;
 * every AI run records which version produced it.
 */
export const BRIEF_VERSION = "article_brief.v1";
export const WRITER_VERSION = "article_writer.v1";
export const QA_VERSION = "quality_review.v1";
export { ARTICLE_SCHEMA };

// ---------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------
export type TopicRow = {
  title: string; primary_keyword: string; search_intent: string; audience: string; business_objective: string;
  angle: string; subtopics: string[]; cta: string; internal_link_ideas: string[];
};
export type AllowedLink = { url: string; label: string };

export function profileForWriters(p: BusinessProfile): string {
  return JSON.stringify({
    business_name: p.business_name,
    summary: p.summary,
    industry: p.industry,
    service_area: p.service_area ?? p.service_area_type,
    services: p.services.map((s) => ({ name: s.name, description: s.description })),
    audience: p.audience.map((a) => a.text),
    pain_points: p.pain_points.map((a) => a.text),
    differentiators: p.differentiators.map((a) => a.text),
    confirmed_facts: p.facts.map((a) => a.text),
    faqs: p.faqs,
    voice: p.voice,
    cta: p.cta,
    prohibited_claims: p.prohibited_claims,
    topics_to_avoid: p.topics_to_avoid,
    regulated_field: p.compliance.regulated_field,
    compliance_notes: p.compliance.notes,
  }, null, 2);
}

export function linksText(links: AllowedLink[]): string {
  return links.length ? links.map((l) => `- ${l.url} (${l.label})`).join("\n") : "- none: write no links";
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------
export type Brief = {
  working_title: string;
  reader: string;
  reader_questions: string[];
  angle: string;
  outline: { heading: string; points: string[] }[];
  facts_to_use: string[];
  must_avoid: string[];
  cta_approach: string;
  link_plan: { anchor_idea: string; url: string }[];
  target_words: number;
};

export const BRIEF_SCHEMA: Schema = obj({
  working_title: str(),
  reader: str("Who is reading and what situation they're in"),
  reader_questions: arr(str(), "The real questions this article must answer", 8),
  angle: str("What makes this genuinely useful and different from generic articles on the topic"),
  outline: arr(obj({ heading: str(), points: arr(str(), undefined, 6) }), "4 to 7 sections", 8),
  facts_to_use: arr(str("A fact from the profile worth using, copied faithfully"), undefined, 12),
  must_avoid: arr(str(), "Claims, angles or overlaps to stay away from", 12),
  cta_approach: str("How and where the call to action fits naturally"),
  link_plan: arr(obj({ anchor_idea: str(), url: str("From ALLOWED LINKS only") }), undefined, 5),
  target_words: int("Within the plan's range", 400, 2500),
});

export const BRIEF_INSTRUCTIONS = `You are the editor planning one blog article for a small business. Produce a tight, specific brief a writer can follow.

Rules:
- Serve the reader first: what do they actually need to know or decide? The business benefits by being genuinely helpful.
- Use only facts from the CONFIRMED PROFILE. Never add credentials, numbers, prices, guarantees, awards, years, locations or claims that aren't there.
- Don't overlap the OTHER ARTICLES listed. Give this one its own job.
- Links: only URLs from ALLOWED LINKS. If none fit, plan none.
- Keep the call to action honest and natural, never pushy.
- Regulated fields (legal, medical, financial): general education only, no individual advice; note what to avoid.`;

export function briefInput(o: {
  profile: BusinessProfile; topic: TopicRow; links: AllowedLink[]; others: string[]; minWords: number; maxWords: number;
}): string {
  return [
    `CONFIRMED PROFILE\n${profileForWriters(o.profile)}`,
    `TOPIC\n${JSON.stringify(o.topic, null, 2)}`,
    `ALLOWED LINKS\n${linksText(o.links)}`,
    `OTHER ARTICLES FOR THIS BUSINESS (do not overlap)\n${o.others.map((t) => `- ${t}`).join("\n") || "- none"}`,
    `LENGTH: ${o.minWords} to ${o.maxWords} words.`,
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------
export const WRITER_INSTRUCTIONS = `You write blog articles for small businesses. Your articles are useful, specific and sound like the business, not like AI.

Content rules:
- Follow the BRIEF. Answer the reader's real questions with practical, concrete detail.
- Facts about the business come only from the CONFIRMED PROFILE. Never invent statistics, studies, quotes, testimonials, customer stories, prices, guarantees, credentials, awards or years in business. If something would need a source you don't have, leave it out or speak generally.
- General knowledge about the field is fine when it's widely accepted and stated carefully. No precise numbers unless the profile gives them.
- Never make a PROHIBITED CLAIM. Never use AVOID TERMS. Use PREFERRED TERMS where they fit.
- Regulated fields: educational only, suggest consulting a qualified professional, no individual advice.
- Write for people, not search engines. Use the primary keyword naturally in the intro and a heading or two; never stuff it.

Style rules:
- Match the profile's tone and style notes. Plain words, short paragraphs, active voice.
- No filler intros ("In today's fast-paced world"), no hype ("game-changer", "unlock", "elevate", "seamless"), no em dashes, no closing "In conclusion".
- Use ## for sections and ### for subsections. Lists only where they genuinely help.

Format rules:
- markdown: the body only. Start with a short intro paragraph. No title line, no HTML, no images, no tables.
- Links: only URLs from ALLOWED LINKS, written as [anchor](url). No other links at all.
- End with the call to action woven into a short closing section.
- source_notes: list every specific claim about the business and where it came from, so an editor can check it.`;

export function writerInput(o: {
  profile: BusinessProfile; topic: TopicRow; brief: Brief; links: AllowedLink[]; minWords: number; maxWords: number;
}): string {
  return [
    `BRIEF\n${JSON.stringify(o.brief, null, 2)}`,
    `TOPIC\n${JSON.stringify({ title: o.topic.title, primary_keyword: o.topic.primary_keyword, cta: o.topic.cta }, null, 2)}`,
    `CONFIRMED PROFILE\n${profileForWriters(o.profile)}`,
    `PROHIBITED CLAIMS\n${o.profile.prohibited_claims.map((c) => `- ${c}`).join("\n") || "- none listed"}`,
    `AVOID TERMS\n${o.profile.voice.avoid_terms.map((c) => `- ${c}`).join("\n") || "- none listed"}`,
    `PREFERRED TERMS\n${o.profile.voice.preferred_terms.map((c) => `- ${c}`).join("\n") || "- none listed"}`,
    `ALLOWED LINKS\n${linksText(o.links)}`,
    `LENGTH: ${o.minWords} to ${o.maxWords} words in the body.`,
  ].join("\n\n");
}

export const REVISION_INSTRUCTIONS = `${WRITER_INSTRUCTIONS}

You are revising an existing draft. Fix every item under REQUIRED CHANGES. Keep what already works; don't rewrite good sections for the sake of it. Return the complete revised article.`;

export function revisionInput(base: string, previous: ArticleContent, changes: string[]): string {
  return [
    base,
    `CURRENT DRAFT\n${JSON.stringify(previous, null, 2)}`,
    `REQUIRED CHANGES\n${changes.map((c) => `- ${c}`).join("\n")}`,
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Quality review
// ---------------------------------------------------------------------------
export type QaIssue = { severity: "blocker" | "major" | "minor"; area: string; problem: string; fix: string };
export type QaReview = {
  scores: { accuracy: number; usefulness: number; relevance: number; voice: number; structure: number; seo: number; cta: number };
  issues: QaIssue[];
  unsupported_claims: { claim: string; why: string }[];
  repeats_other_articles: boolean;
  high_risk: boolean;
  high_risk_reason: string;
  summary: string;
};

const score = (what: string) => int(`1 to 5: ${what}`, 1, 5);
export const QA_SCHEMA: Schema = obj({
  scores: obj({
    accuracy: score("every business claim is supported by the profile; nothing invented"),
    usefulness: score("a reader gets real, specific help"),
    relevance: score("fits the topic, the reader and the business's services"),
    voice: score("matches the profile's tone and style; doesn't read as generic AI"),
    structure: score("clear intro, logical sections, scannable"),
    seo: score("keyword used naturally, title and meta accurate and compelling"),
    cta: score("call to action present, natural and correct"),
  }),
  issues: arr(obj({
    severity: oneOf(["blocker", "major", "minor"]),
    area: oneOf(["accuracy", "usefulness", "relevance", "voice", "structure", "seo", "cta", "compliance", "repetition"]),
    problem: str("Specific, quoting the text where possible"),
    fix: str("Exactly what the writer should change"),
  }), undefined, 20),
  unsupported_claims: arr(obj({ claim: str(), why: str() }), "Claims about the business, or precise figures, not backed by the profile", 15),
  repeats_other_articles: bool(),
  high_risk: bool("true if legal, medical, financial or safety content could harm a reader, or a claim could create liability"),
  high_risk_reason: str("Empty if not high risk"),
  summary: str("Two sentences for the human editor"),
});

export const QA_INSTRUCTIONS = `You are a strict, fair editor reviewing a blog article before a human editor sees it. Your job is to catch problems, not to praise.

Check:
- Accuracy: every claim about the business must be supported by the CONFIRMED PROFILE. Flag invented statistics, studies, quotes, testimonials, prices, guarantees, credentials or specifics. Precise figures without a source are unsupported.
- Prohibited claims and avoided terms: any use is a blocker.
- Usefulness and relevance: does it answer the reader's real questions for this business's services, or is it generic filler?
- Voice: does it match the profile's tone? Flag AI cliches, hype words and padding.
- Structure, SEO and CTA: clear sections, natural keyword use, accurate title and meta, a fitting call to action near the end.
- Repetition: substantially repeats one of the OTHER ARTICLES.
- Compliance: regulated topics must stay general and educational.

Severity: blocker = must not publish (false or risky claims, prohibited content). major = clearly hurts quality. minor = polish.
Be specific: quote the problem text and say exactly how to fix it.`;

export function qaInput(o: {
  profile: BusinessProfile; topic: TopicRow; brief: Brief | null; article: ArticleContent; others: string[];
  codeFindings: string[];
}): string {
  return [
    `CONFIRMED PROFILE\n${profileForWriters(o.profile)}`,
    `TOPIC\n${JSON.stringify({ title: o.topic.title, primary_keyword: o.topic.primary_keyword, audience: o.topic.audience }, null, 2)}`,
    o.brief ? `BRIEF\n${JSON.stringify(o.brief, null, 2)}` : "",
    `OTHER ARTICLES FOR THIS BUSINESS\n${o.others.map((t) => `- ${t}`).join("\n") || "- none"}`,
    `AUTOMATED CHECKS ALREADY FOUND\n${o.codeFindings.map((t) => `- ${t}`).join("\n") || "- nothing"}`,
    `ARTICLE\n${JSON.stringify(o.article, null, 2)}`,
  ].filter(Boolean).join("\n\n");
}

/** Pass/fail is decided in code, not by the model. */
export function qaPasses(review: QaReview, codeErrors: number): boolean {
  return codeErrors === 0
    && !review.issues.some((i) => i.severity === "blocker" || i.severity === "major")
    && review.unsupported_claims.length === 0
    && review.scores.accuracy >= 4
    && Math.min(review.scores.usefulness, review.scores.relevance, review.scores.voice) >= 3;
}

/** The changes a revision must make, from code findings and the AI review. */
export function changesFrom(codeFindings: { severity: string; message: string }[], review: QaReview | null): string[] {
  const out = codeFindings.filter((f) => f.severity !== "info").map((f) => f.message);
  if (review) {
    for (const i of review.issues) if (i.severity !== "minor") out.push(`${i.problem} Fix: ${i.fix}`);
    for (const c of review.unsupported_claims) out.push(`Remove or soften the unsupported claim "${c.claim}" (${c.why}).`);
    if (!out.length) for (const i of review.issues) out.push(`${i.problem} Fix: ${i.fix}`);
  }
  return out.slice(0, 25);
}
