import { CustomerShell, Notice } from "@/app/customer-shell";
import { getDb } from "@/lib/db/client";
import { MIN_PASSWORD, peekLoginLink } from "@/lib/customer/auth";
import { linkPasswordAction, linkSignInAction } from "../../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Blogs on Tap" };

const ERRORS: Record<string, string> = {
  mismatch: "The two passwords don't match.",
  used: "This link was already used or has expired.",
};

/**
 * Where every emailed login link lands. Opening the page never uses the link
 * up (mail scanners open links); only pressing the button does.
 */
export default async function LoginLinkPage({ params, searchParams }: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; msg?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const link = await peekLoginLink(await getDb(), token);
  if (!link) {
    return (
      <CustomerShell nav={false}>
        <Notice title="This link has expired or was already used">
          Links like this work once and only for a short time. <a href="/login">Go to the sign-in page</a> to get a fresh one.
        </Notice>
      </CustomerShell>
    );
  }
  const error = sp.error === "weak" ? (sp.msg || "Pick a stronger password.") : sp.error ? ERRORS[sp.error] : null;
  const alert = error && <p className="flash err" role="alert">{error}</p>;

  if (link.purpose === "sign_in" || (link.purpose === "invite" && link.hasPassword)) {
    const join = link.purpose === "invite";
    return (
      <CustomerShell nav={false}>
        <section className="card auth">
          <h1>{join ? `Join ${link.orgName}` : "Sign in to Blogs on Tap"}</h1>
          <p className="muted" style={{ marginTop: 0 }}>
            {join ? `${link.inviter ?? "The owner"} invited you. You'll sign in with your usual login: ${link.email}.` : `Signing in as ${link.email}.`}
          </p>
          {alert}
          <form action={linkSignInAction.bind(null, token)} className="stack">
            <button type="submit">{join ? "Join and sign in" : "Sign in"}</button>
          </form>
        </section>
      </CustomerShell>
    );
  }

  const copy = {
    account_setup: { h: "Set up your login", p: "Pick a password. From now on you'll sign in with your email and this password.", b: "Save and sign in" },
    password_reset: { h: "Pick a new password", p: "This signs you out everywhere else.", b: "Save new password" },
    invite: { h: `Join ${link.orgName}`, p: `${link.inviter ?? "The owner"} invited you to see and approve their blog articles. Pick a password to finish.`, b: "Join and sign in" },
    sign_in: { h: "", p: "", b: "" },
  }[link.purpose];

  return (
    <CustomerShell nav={false}>
      <section className="card auth">
        <h1>{copy.h}</h1>
        <p className="muted" style={{ marginTop: 0 }}>{copy.p}</p>
        {alert}
        <form action={linkPasswordAction.bind(null, token)} className="stack">
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={link.email} readOnly autoComplete="username" />
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
          <button type="submit">{copy.b}</button>
        </form>
      </section>
    </CustomerShell>
  );
}
