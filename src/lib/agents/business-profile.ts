import { arr, bool, nullableStr, obj, oneOf, str, type Schema } from "@/lib/ai/json-schema";

/** Contract for Agent A output and every later profile version. */
const fact = (what: string) => obj({
  text: str(what),
  source: str('Where this came from: "customer", "website: <page url>" or "document: <file name>"'),
  needs_confirmation: bool("true unless the customer stated it directly in their answers"),
});

export const PROFILE_SCHEMA: Schema = obj({
  business_name: str(),
  summary: str("Two or three plain sentences describing the business, from confirmed information"),
  industry: str(),
  service_area_type: oneOf(["local", "regional", "national", "online"]),
  service_area: nullableStr("Cities or regions served, or null"),
  services: arr(obj({
    name: str(),
    description: str("One or two sentences"),
    priority: bool("true if the customer wants to grow this one"),
    source: str(),
    needs_confirmation: bool(),
  }), "Products and services offered", 25),
  audience: arr(fact("A customer segment and what they need"), undefined, 8),
  pain_points: arr(fact("A problem that brings customers to the business"), undefined, 12),
  differentiators: arr(fact("A true reason customers choose this business"), undefined, 10),
  faqs: arr(str(), "Questions customers ask", 25),
  facts: arr(fact("Another concrete fact about the business, e.g. years operating or a stated license"), undefined, 15),
  voice: obj({
    tone: arr(str(), undefined, 8),
    style_notes: arr(str("A short, concrete writing instruction"), undefined, 10),
    preferred_terms: arr(str(), undefined, 25),
    avoid_terms: arr(str(), undefined, 25),
  }),
  cta: obj({ text: str(), destination: str() }),
  prohibited_claims: arr(str(), "Claims the content must never make", 20),
  topics_to_avoid: arr(str(), undefined, 25),
  priority_topics: arr(str(), undefined, 25),
  existing_content: arr(str("Title of an article the business has already published"), undefined, 100),
  compliance: obj({
    regulated_field: oneOf(["none", "legal", "medical", "financial", "other"]),
    notes: arr(str(), undefined, 10),
  }),
  open_questions: arr(str("Something important we could not determine"), undefined, 8),
});

export type Fact = { text: string; source: string; needs_confirmation: boolean };
export type Service = { name: string; description: string; priority: boolean; source: string; needs_confirmation: boolean };

export type BusinessProfile = {
  business_name: string;
  summary: string;
  industry: string;
  service_area_type: "local" | "regional" | "national" | "online";
  service_area: string | null;
  services: Service[];
  audience: Fact[];
  pain_points: Fact[];
  differentiators: Fact[];
  faqs: string[];
  facts: Fact[];
  voice: { tone: string[]; style_notes: string[]; preferred_terms: string[]; avoid_terms: string[] };
  cta: { text: string; destination: string };
  prohibited_claims: string[];
  topics_to_avoid: string[];
  priority_topics: string[];
  existing_content: string[];
  compliance: { regulated_field: "none" | "legal" | "medical" | "financial" | "other"; notes: string[] };
  open_questions: string[];
};

/** The fact lists a customer reviews item by item. */
export const FACT_LISTS = ["services", "audience", "pain_points", "differentiators", "facts"] as const;
export type FactList = (typeof FACT_LISTS)[number];

/**
 * The model's own label is not trusted: anything not sourced to the
 * customer's answers must be confirmed by the customer.
 */
export function enforceConfirmationFlags(p: BusinessProfile): BusinessProfile {
  const fix = <T extends { source: string; needs_confirmation: boolean }>(x: T): T =>
    ({ ...x, source: x.source.trim() || "unknown", needs_confirmation: x.needs_confirmation || x.source.trim().toLowerCase() !== "customer" });
  return {
    ...p,
    services: p.services.map(fix),
    audience: p.audience.map(fix),
    pain_points: p.pain_points.map(fix),
    differentiators: p.differentiators.map(fix),
    facts: p.facts.map(fix),
  };
}

export function unconfirmedCount(p: BusinessProfile): number {
  return FACT_LISTS.reduce((n, k) => n + (p[k] as { needs_confirmation: boolean }[]).filter((x) => x.needs_confirmation).length, 0);
}
