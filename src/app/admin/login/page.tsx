import { loginAction } from "../actions";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  invalid: "That didn't work. Check your password and the 6-digit code, then try again.",
  locked: "Too many tries. For safety, login is paused for 15 minutes.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="login">
      <div className="brand" style={{ fontSize: 20, marginBottom: 4 }}>
        Blogs on <span>Tap</span>
      </div>
      <p className="sub">Admin sign in</p>
      {error && MESSAGES[error] ? <p className="notice err">{MESSAGES[error]}</p> : null}
      <form action={loginAction}>
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
        <label htmlFor="code">6-digit code from your authenticator app</label>
        <input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
        />
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
