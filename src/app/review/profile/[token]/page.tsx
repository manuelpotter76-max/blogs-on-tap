import { getDb } from "@/lib/db/client";
import { resolveLink } from "@/lib/links";
import { loadProfileForReview } from "@/lib/review/profile";
import type { FactList } from "@/lib/agents/business-profile";
import { CustomerShell, Notice } from "@/app/customer-shell";
import { confirmProfileAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Check your profile | Blogs on Tap" };

const SECTIONS: { list: FactList; title: string; hint: string }[] = [
  { list: "services", title: "What you offer", hint: "We'll only write about services you keep here." },
  { list: "audience", title: "Who you serve", hint: "" },
  { list: "pain_points", title: "Problems that bring customers to you", hint: "" },
  { list: "differentiators", title: "Why customers choose you", hint: "These may appear in articles, so keep only what's true." },
  { list: "facts", title: "Other facts about your business", hint: "Things like years in business or licenses. Remove anything that's wrong or you'd rather not mention." },
];

const ERRORS: Record<string, string> = {
  undecided: "Please choose Keep or Remove for every item marked \"please confirm\".",
  invalid: "Something's missing.",
  stale: "We've updated your profile since this link was sent. Here's the latest version.",
  not_awaiting: "This profile has already been confirmed.",
};

function sourceLabel(source: string): string {
  if (source === "customer") return "From your answers";
  if (source.startsWith("website:")) return `Found on your website (${source.slice(8).trim()})`;
  if (source.startsWith("document:")) return `From your file ${source.slice(9).trim()}`;
  return `Source: ${source}`;
}

export default async function ProfileReviewPage({ params, searchParams }: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string; error?: string; detail?: string }>;
}) {
  const { token } = await params;
  const { done, error, detail } = await searchParams;
  const db = await getDb();
  const link = await resolveLink(db, token, "profile_review");
  if (!link) {
    return (
      <CustomerShell>
        <Notice title="This link isn't working">It may have expired. Reply to our email and we&apos;ll send a fresh one.</Notice>
      </CustomerShell>
    );
  }
  const p = await loadProfileForReview(db, link.org_id, link.subject_id);
  if (!p) return <CustomerShell><Notice title="Not ready yet">We&apos;re still working on your profile. Check back soon.</Notice></CustomerShell>;

  if (done || p.status === "confirmed") {
    return (
      <CustomerShell>
        <Notice title="Thanks, your profile is confirmed">
          Next we&apos;ll draft a list of article topics for you. You&apos;ll get an email to pick the ones you like.
        </Notice>
      </CustomerShell>
    );
  }
  if (p.status !== "awaiting_customer") {
    return <CustomerShell><Notice title="Not ready yet">We&apos;re updating your profile. You&apos;ll get an email when it&apos;s ready.</Notice></CustomerShell>;
  }

  const d = p.data;
  const action = confirmProfileAction.bind(null, token);
  const errorText = error ? `${ERRORS[error] ?? "Something went wrong."}${detail && error === "invalid" ? ` (${detail})` : ""}` : null;

  return (
    <CustomerShell>
      <form action={action}>
        <input type="hidden" name="version_id" value={p.versionId} />
        <section className="card">
          <h1>Did we get your business right?</h1>
          <p className="sub">Every article leans on this, so a few minutes here pays off. Items marked
            <span className="tag">please confirm</span> came from your website or files rather than your answers.</p>
          {errorText && <p className="flash err" role="alert">{errorText}</p>}
          <div className="field">
            <label htmlFor="summary">In a nutshell</label>
            <textarea id="summary" name="summary" rows={4} required maxLength={2000} defaultValue={d.summary} />
          </div>
        </section>

        {SECTIONS.map(({ list, title, hint }) => {
          const items = (d[list] as { name?: string; description?: string; text?: string; source: string; needs_confirmation: boolean }[]);
          if (!items.length) return null;
          return (
            <section className="card" key={list}>
              <h2 style={{ marginTop: 0 }}>{title}</h2>
              {hint && <p className="help">{hint}</p>}
              <input type="hidden" name={`${list}__count`} value={items.length} />
              {items.map((it, i) => (
                <div className="item" key={i}>
                  <div className="what">
                    <div>{it.name ? <strong>{it.name}</strong> : it.text}{it.needs_confirmation && <span className="tag">please confirm</span>}</div>
                    {it.description && <div>{it.description}</div>}
                    <div className="src">{sourceLabel(it.source)}</div>
                  </div>
                  <div className="choice">
                    <label><input type="radio" name={`${list}__${i}`} value="keep" required={it.needs_confirmation}
                      defaultChecked={!it.needs_confirmation} /> Keep</label>
                    <label><input type="radio" name={`${list}__${i}`} value="remove" /> Remove</label>
                  </div>
                </div>
              ))}
            </section>
          );
        })}

        <section className="card">
          <h2 style={{ marginTop: 0 }}>How articles should end</h2>
          <div className="field">
            <label htmlFor="cta_text">Call to action</label>
            <input id="cta_text" name="cta_text" type="text" required maxLength={200} defaultValue={d.cta.text} />
          </div>
          <div className="field">
            <label htmlFor="cta_destination">Where it sends people</label>
            <input id="cta_destination" name="cta_destination" type="text" required maxLength={300} defaultValue={d.cta.destination} />
          </div>
          {d.voice.tone.length > 0 && <p className="help">Tone: {d.voice.tone.join(", ")}</p>}
          {d.voice.style_notes.length > 0 && (
            <ul className="help">{d.voice.style_notes.map((s, i) => <li key={i}>{s}</li>)}</ul>
          )}
        </section>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Guardrails</h2>
          <div className="field">
            <label htmlFor="prohibited_claims">Claims we must never make</label>
            <p className="help">One per line.</p>
            <textarea id="prohibited_claims" name="prohibited_claims" rows={4} defaultValue={d.prohibited_claims.join("\n")} />
          </div>
          <div className="field">
            <label htmlFor="topics_to_avoid">Topics to stay away from</label>
            <p className="help">One per line.</p>
            <textarea id="topics_to_avoid" name="topics_to_avoid" rows={4} defaultValue={d.topics_to_avoid.join("\n")} />
          </div>
        </section>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Anything else?</h2>
          {d.open_questions.length > 0 && (
            <>
              <p className="help">A few things we couldn&apos;t work out. Answer any you like:</p>
              <ul>{d.open_questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
            </>
          )}
          <div className="field">
            <label htmlFor="notes">Notes for our writers (optional)</label>
            <textarea id="notes" name="notes" rows={4} maxLength={3000} />
          </div>
          <div className="nav"><span /><button type="submit">Confirm my profile</button></div>
        </section>
      </form>
    </CustomerShell>
  );
}
