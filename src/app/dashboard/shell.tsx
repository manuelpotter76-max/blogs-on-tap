import type { ReactNode } from "react";
import type { CustomerSession } from "@/lib/customer/auth";
import { signOutAction } from "./actions";

/** Frame for signed-in customer pages. */
export function DashboardShell({ s, active, children }: { s: CustomerSession; active: "home" | "account"; children: ReactNode }) {
  return (
    <div className="customer">
      <header className="dash-top">
        <div className="dash-top-inner">
          <a href="/dashboard" className="brand">Blogs <span>on Tap</span></a>
          <nav className="dash-nav" aria-label="Dashboard">
            <a href="/dashboard" aria-current={active === "home" ? "page" : undefined}>Home</a>
            <a href="/dashboard/account" aria-current={active === "account" ? "page" : undefined}>Account</a>
            <form action={signOutAction}><button type="submit" className="link">Sign out</button></form>
          </nav>
        </div>
        <p className="dash-org">{s.orgName}</p>
      </header>
      <main className="customer-main">{children}</main>
    </div>
  );
}
