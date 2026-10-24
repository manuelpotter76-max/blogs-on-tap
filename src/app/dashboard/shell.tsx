import type { ReactNode } from "react";
import type { CustomerSession } from "@/lib/customer/auth";
import { DashHeader } from "@/app/customer-shell";

/** Frame for signed-in dashboard pages. */
export function DashboardShell({ s, active, children }: { s: CustomerSession; active: "home" | "account"; children: ReactNode }) {
  return (
    <div className="customer">
      <DashHeader s={s} active={active} />
      <main className="customer-main">{children}</main>
    </div>
  );
}
