import { getDb } from "@/lib/db/client";
import { resolveLink } from "@/lib/links";
import { loadOnboarding } from "@/lib/onboarding/store";
import { MIN_PASSWORD, ownerOf } from "@/lib/customer/auth";
import { currentCustomer } from "@/lib/customer/session";
import { CustomerShell, Notice } from "@/app/customer-shell";
import { setupLoginAction } from "../actions";
import { OnboardingForm } from "./form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Get started | Blogs on Tap" };

const SETUP_ERRORS: Record<string, string> = { mismatch: "The two passwords don't match." };

export default async function StartPage({ params, searchParams }: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ setup?: string; msg?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const link = await resolveLink(db, token, "onboarding");
  if (!link) {
    return (
      <CustomerShell>
        <Notice title="This link isn't working">
          It may have expired or been replaced by a newer one. Reply to your welcome email and we'll send you a fresh link.
        </Notice>
      </CustomerShell>
    );
  }

  // Step one for a new customer: set up the login, then the questionnaire.
  const [owner, signedIn] = await Promise.all([ownerOf(db, link.org_id), currentCustomer()]);
  if (owner && !owner.login_ready_at && signedIn?.orgId !== link.org_id) {
    const error = sp.setup === "weak" ? (sp.msg || "Pick a stronger password.") : sp.setup ? SETUP_ERRORS[sp.setup] : null;
    return (
      <CustomerShell>
        <section className="card auth">
          <p className="step-count" style={{ marginTop: 0 }}>Step 1 of 2</p>
          <h1>Set up your login</h1>
          <p className="muted" style={{ marginTop: 0 }}>
            This is how you'll get back to your dashboard to read articles, pick topics and see your plan. Then we'll go straight to the questionnaire.
          </p>
          {error && <p className="flash err" role="alert">{error}</p>}
          <form action={setupLoginAction.bind(null, token)} className="stack">
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="email">Email</label>
              <p className="help">This is your username. It's the email you signed up with.</p>
              <input id="email" type="email" value={owner.email} readOnly autoComplete="username" />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="password">Password</label>
              <p className="help">At least {MIN_PASSWORD} characters. A short phrase is easier to remember than symbols.</p>
              <input id="password" name="password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} maxLength={200} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="confirm">Type it again</label>
              <input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} maxLength={200} />
            </div>
            <button type="submit">Save and continue</button>
          </form>
        </section>
      </CustomerShell>
    );
  }

  const state = await loadOnboarding(db, link.org_id);
  if (state.submittedAt) {
    return (
      <CustomerShell>
        <Notice title="Thanks, we've got everything">
          We're putting together your business profile now. You'll get an email within a day asking you to check it.
          Nothing gets written until you've confirmed it. <a href="/dashboard">Go to your dashboard</a>
        </Notice>
      </CustomerShell>
    );
  }

  return (
    <CustomerShell>
      {sp.setup === "done" && (
        <p className="flash ok" role="status">Your login is saved. Next, tell us about your business. You can always get back at app.blogsontap.com.</p>
      )}
      <OnboardingForm token={token} initial={state} />
    </CustomerShell>
  );
}
