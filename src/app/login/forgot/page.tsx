import { CustomerShell } from "@/app/customer-shell";
import { forgotPasswordAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reset your password | Blogs on Tap" };

export default async function ForgotPage({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const { sent } = await searchParams;
  return (
    <CustomerShell nav={false}>
      <section className="card auth">
        <h1>Reset your password</h1>
        {sent ? (
          <p className="flash ok" role="status">If that email has an account, a reset link is on its way. It works for one hour.</p>
        ) : (
          <p className="muted" style={{ marginTop: 0 }}>Enter the email you use for Blogs on Tap and we'll send you a link to pick a new password.</p>
        )}
        <form action={forgotPasswordAction} className="stack">
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="username" required maxLength={254} />
          </div>
          <button type="submit">Send the reset link</button>
        </form>
        <p className="fine"><a href="/login">Back to sign in</a></p>
      </section>
    </CustomerShell>
  );
}
