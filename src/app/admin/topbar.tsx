import { logoutAction } from "./actions";

export function Topbar() {
  return (
    <header className="topbar">
      <a href="/admin" className="brand" style={{ color: "inherit" }}>
        Blogs on <span>Tap</span> <small style={{ color: "var(--muted)", fontWeight: 500 }}>admin</small>
      </a>
      <form action={logoutAction}>
        <button type="submit" className="ghost">Sign out</button>
      </form>
    </header>
  );
}
