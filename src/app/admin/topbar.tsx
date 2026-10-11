import { logoutAction } from "./actions";

export function Topbar() {
  return (
    <header className="topbar">
      <a href="/admin" className="brand" style={{ color: "inherit" }}>
        Blogs on <span>Tap</span> <small style={{ color: "var(--muted)", fontWeight: 500 }}>admin</small>
      </a>
      <nav style={{ display: "flex", gap: 18, marginLeft: 28, marginRight: "auto" }}>
        <a href="/admin">Customers</a>
        <a href="/admin/articles">Articles</a>
      </nav>
      <form action={logoutAction}>
        <button type="submit" className="ghost">Sign out</button>
      </form>
    </header>
  );
}
