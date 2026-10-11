/**
 * The onboarding questionnaire, as data. The form renders from this, the
 * server validates against it, and the research agent reads answers by these
 * keys. Shared by server and browser code, so no Node imports here.
 */
export type FieldType = "text" | "textarea" | "url" | "email" | "tel" | "select" | "multiselect" | "lines";

export type Field = {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  help?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  max?: number;                                    // max characters (or items for lines)
  showIf?: { key: string; notIn?: string[]; in?: string[] };
};

export type Step = { id: string; title: string; intro: string; fields: Field[] };

const opts = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

export const STEPS: Step[] = [
  {
    id: "business",
    title: "Your business",
    intro: "The basics. We use this everywhere, so it's worth getting exactly right.",
    fields: [
      { key: "business_name", label: "Business name", type: "text", required: true, max: 120 },
      { key: "website", label: "Website", type: "url", placeholder: "https://", max: 300,
        help: "Leave blank if you don't have one yet." },
      { key: "industry", label: "Industry", type: "text", required: true, max: 120,
        placeholder: "e.g. residential plumbing, family dentistry, bookkeeping" },
      { key: "description", label: "What does your business do?", type: "textarea", required: true, max: 2000,
        help: "Two or three sentences, the way you'd explain it to a new customer." },
      { key: "service_area_type", label: "Where do you work?", type: "select", required: true,
        options: opts(["local", "One city or town"], ["regional", "A region or several cities"],
                      ["national", "Nationwide"], ["online", "Online, anywhere"]) },
      { key: "service_area", label: "Service area", type: "text", required: true, max: 300,
        placeholder: "e.g. Tampa, Brandon and Riverview",
        showIf: { key: "service_area_type", in: ["local", "regional"] } },
      { key: "contact_name", label: "Your name", type: "text", required: true, max: 120 },
      { key: "contact_phone", label: "Best phone number (optional)", type: "tel", max: 40 },
    ],
  },
  {
    id: "offerings",
    title: "What you sell",
    intro: "Articles should point readers toward what you actually offer.",
    fields: [
      { key: "services", label: "Main products or services", type: "lines", required: true, max: 25,
        help: "One per line." },
      { key: "priority_services", label: "Which ones do you most want to grow?", type: "lines", max: 10,
        help: "One per line. Optional, but it helps us aim." },
      { key: "restrictions", label: "Anything you don't do, or limits we should know?", type: "textarea", max: 1000,
        placeholder: "e.g. no commercial jobs, no emergency calls after 9pm" },
    ],
  },
  {
    id: "customers",
    title: "Your customers",
    intro: "Good articles answer real questions from real customers.",
    fields: [
      { key: "audience", label: "Who are your best customers?", type: "textarea", required: true, max: 1500 },
      { key: "pain_points", label: "What problems bring them to you?", type: "textarea", required: true, max: 1500 },
      { key: "faqs", label: "Questions customers ask you all the time", type: "lines", max: 20,
        help: "One per line. These often make the best articles." },
      { key: "differentiators", label: "Why do people choose you over others?", type: "textarea", required: true,
        max: 1500, help: "Only things that are true and you're comfortable saying publicly." },
    ],
  },
  {
    id: "voice",
    title: "How you sound",
    intro: "So the writing sounds like you, and never says something you wouldn't.",
    fields: [
      { key: "tone", label: "Tone", type: "multiselect", required: true,
        options: opts(["friendly", "Friendly"], ["professional", "Professional"], ["expert", "Expert"],
                      ["warm", "Warm"], ["direct", "Plain and direct"], ["playful", "Playful"],
                      ["reassuring", "Reassuring"]) },
      { key: "writing_samples", label: "Writing you like (optional)", type: "textarea", max: 4000,
        help: "Paste a paragraph you wrote, or links to articles whose style you like." },
      { key: "preferred_terms", label: "Words or phrases you always use (optional)", type: "lines", max: 20 },
      { key: "avoid_terms", label: "Words or phrases to never use (optional)", type: "lines", max: 20 },
      { key: "prohibited_claims", label: "Claims we must never make", type: "textarea", max: 1500,
        placeholder: "e.g. never promise same-day service, never say 'cheapest'" },
      { key: "regulated", label: "Is your field regulated?", type: "select", required: true,
        options: opts(["none", "No"], ["legal", "Legal"], ["medical", "Medical or health"],
                      ["financial", "Financial or insurance"], ["other", "Other licensed field"]) },
      { key: "compliance_notes", label: "Rules or disclaimers we should follow", type: "textarea", max: 2000,
        showIf: { key: "regulated", notIn: ["none", ""] },
        help: "Articles in regulated fields always get an extra human review before you see them." },
    ],
  },
  {
    id: "marketing",
    title: "Goals for your blog",
    intro: "What a reader should do after reading.",
    fields: [
      { key: "goals", label: "What should the blog do for you?", type: "multiselect", required: true,
        options: opts(["leads", "Bring in calls and leads"], ["local", "Show up in local searches"],
                      ["trust", "Build trust and authority"], ["educate", "Educate customers"],
                      ["support", "Cut down on repeat questions"]) },
      { key: "cta", label: "Main call to action", type: "text", required: true, max: 200,
        placeholder: "e.g. Call for a free estimate" },
      { key: "cta_destination", label: "Where should that send people?", type: "text", required: true, max: 300,
        placeholder: "a page link, phone number or email" },
      { key: "priority_topics", label: "Topics you'd love us to cover (optional)", type: "lines", max: 20 },
      { key: "avoid_topics", label: "Topics to stay away from (optional)", type: "lines", max: 20 },
      { key: "has_blog", label: "Do you already have a blog?", type: "select", required: true,
        options: opts(["no", "No"], ["yes", "Yes"]) },
      { key: "blog_url", label: "Blog address", type: "url", max: 300, placeholder: "https://",
        showIf: { key: "has_blog", in: ["yes"] } },
      { key: "existing_titles", label: "Titles of posts you've already published (optional)", type: "lines", max: 100,
        showIf: { key: "has_blog", in: ["yes"] }, help: "One per line, so we don't repeat them." },
    ],
  },
];

/** Step index for the uploads/consent screen and the review screen, after the question steps. */
export const FILES_STEP = STEPS.length;
export const REVIEW_STEP = STEPS.length + 1;
export const TOTAL_STEPS = STEPS.length + 2;

export type Answers = Record<string, string | string[]>;

export function isVisible(field: Field, answers: Answers): boolean {
  if (!field.showIf) return true;
  const v = String(answers[field.showIf.key] ?? "");
  if (field.showIf.in) return field.showIf.in.includes(v);
  if (field.showIf.notIn) return !field.showIf.notIn.includes(v);
  return true;
}

function isUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Coerce raw input to the field's shape and drop unknown or hidden keys. */
export function cleanAnswers(raw: unknown): Answers {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Answers = {};
  for (const step of STEPS) {
    for (const f of step.fields) {
      const v = input[f.key];
      if (f.type === "multiselect") {
        const allowed = new Set(f.options!.map((o) => o.value));
        const arr = Array.isArray(v) ? v.map(String).filter((x) => allowed.has(x)) : [];
        out[f.key] = [...new Set(arr)];
      } else if (f.type === "lines") {
        const arr = (Array.isArray(v) ? v.map(String) : String(v ?? "").split("\n"))
          .map((s) => s.trim().slice(0, 300)).filter(Boolean);
        out[f.key] = arr.slice(0, f.max ?? 50);
      } else if (f.type === "select") {
        const s = String(v ?? "");
        out[f.key] = f.options!.some((o) => o.value === s) ? s : "";
      } else {
        out[f.key] = String(v ?? "").trim().slice(0, f.max ?? 2000);
      }
    }
  }
  for (const step of STEPS) {
    for (const f of step.fields) if (!isVisible(f, out)) delete out[f.key];
  }
  return out;
}

/** Errors for one step, keyed by field. Empty object means the step is complete. */
export function stepErrors(stepIndex: number, answers: Answers): Record<string, string> {
  const step = STEPS[stepIndex];
  if (!step) return {};
  const errors: Record<string, string> = {};
  for (const f of step.fields) {
    if (!isVisible(f, answers)) continue;
    const v = answers[f.key];
    const empty = Array.isArray(v) ? v.length === 0 : !String(v ?? "").trim();
    if (f.required && empty) {
      errors[f.key] = f.type === "multiselect" ? "Pick at least one." : "This one's needed.";
      continue;
    }
    if (!empty && f.type === "url" && !isUrl(String(v))) errors[f.key] = "Use a full address starting with https://";
    if (!empty && f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) errors[f.key] = "That email doesn't look right.";
  }
  return errors;
}

/** First incomplete question step, or -1 when every step is complete. */
export function firstIncompleteStep(answers: Answers): number {
  for (let i = 0; i < STEPS.length; i++) if (Object.keys(stepErrors(i, answers)).length) return i;
  return -1;
}
