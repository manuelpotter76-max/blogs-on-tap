import { redirect } from "next/navigation";
import { CustomerShell } from "@/app/customer-shell";
import { safeNext } from "@/lib/customer/auth";
import { currentCustomer } from "@/lib/customer/session";
import { emailLinkAction, passwordSignInAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in | Blogs on Tap" };

const ERRORS: Record<string, string> = {
  invalid: "That email and password don't match. Try again, or get a sign-in link by email below.",
  throttled: "Too many tries, so password sign-in is paused for 15 minutes. You can still get a sign-in link by email.",
  no_business: "Your login isn't connected to an active Blogs on Tap account. Reply to any of our emails and we'll sort it out.",
};

export default async function LoginPage({ searchParams }: {
  searchParams: Promise<{ error?: string; sent?: string; out?: string; next?: string }>;
}) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  if (await currentCustomer()) redirect(next);
  const error = sp.error ? ERRORS[sp.error] ?? "Something went wrong. Please try again." : null;

  return (
    <CustomerShell nav={false}>
      <section className="card auth">
        <h1>Sign in</h1>
        <p className="muted" style={{ marginTop: 0 }}>See your articles, topics and plan.</p>
        {sp.out && <p className="flash ok" role="status">You're signed out.</p>}
        {sp.sent === "link" && (
          <p className="flash ok" role="status">If that email has an account, a sign-in link is on its way. It works for 15 minutes.</p>
        )}
        {error && <p className="flash err" role="alert">{error}</p>}
        <form action={passwordSignInAction} className="stack">
          <input type="hidden" name="next" value={next} />
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="username" required maxLength={254} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="password">Password</label>
            <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={200} />
          </div>
          <button type="submit">Sign in</button>
          <div className="or">or</div>
          <button type="submit" className="secondary" formAction={emailLinkAction} formNoValidate>Email me a sign-in link</button>
        </form>
        <p className="fine"><a href="/login/forgot">Forgot your password?</a></p>
      </section>
    </CustomerShell>
  );
}
