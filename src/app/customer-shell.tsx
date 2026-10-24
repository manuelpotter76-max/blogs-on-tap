import type { ReactNode } from "react";
import type { CustomerSession } from "@/lib/customer/auth";
import { currentCustomer } from "@/lib/customer/session";
import { signOutAction } from "@/app/dashboard/actions";

/** The signed-in top bar: same on the dashboard and on every article, profile and topic page. */
export function DashHeader({ s, active }: { s: CustomerSession; active?: "home" | "account" }) {
  return (
    <header className="dash-top">
      <div className="dash-top-inner">
        <a href="/dashboard" className="brand">Blogs <span>on Tap</span></a>
        <nav className="dash-nav" aria-label="Dashboard">
          <a href="/dashboard" aria-current={active === "home" ? "page" : undefined}>{active ? "Home" : "← Dashboard"}</a>
          <a href="/dashboard/account" aria-current={active === "account" ? "page" : undefined}>Account</a>
          <form action={signOutAction}><button type="submit" className="link">Sign out</button></form>
        </nav>
      </div>
      <p className="dash-org">{s.orgName}</p>
    </header>
  );
}

/**
 * Frame for every customer page reached from an email link (questionnaire,
 * profile, topics, articles). Signed in: the dashboard menu. Not signed in:
 * a "Your dashboard" link that signs them in and brings them back.
 * Sign-in pages pass nav={false}.
 */
export async function CustomerShell({ children, nav = true }: { children: ReactNode; nav?: boolean }) {
  const s = nav ? await currentCustomer() : null;
  return (
    <div className="customer">
      {s ? <DashHeader s={s} /> : (
        <header className={nav ? "customer-top with-link" : "customer-top"}>
          <a href={nav ? "/dashboard" : "/login"} className="brand">Blogs <span>on Tap</span></a>
          {nav && <a href="/dashboard" className="dash-link">Your dashboard →</a>}
        </header>
      )}
      <main className="customer-main">{children}</main>
    </div>
  );
}

export function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card message">
      <h1>{title}</h1>
      <p>{children}</p>
    </section>
  );
}
