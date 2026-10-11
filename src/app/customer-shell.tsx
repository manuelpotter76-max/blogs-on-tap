import type { ReactNode } from "react";

/** Frame for every customer-facing page (onboarding and review links). */
export function CustomerShell({ children }: { children: ReactNode }) {
  return (
    <div className="customer">
      <header className="customer-top">
        <span className="brand">Blogs <span>on Tap</span></span>
      </header>
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
