import { getDb } from "@/lib/db/client";
import { resolveLink } from "@/lib/links";
import { loadForCustomer } from "@/lib/articles/review";
import { exportHtml, exportMarkdown } from "@/lib/articles/export";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const db = await getDb();
  const link = await resolveLink(db, token, "article_review");
  const view = link?.subject_id ? await loadForCustomer(db, link.org_id, link.subject_id) : null;
  if (!link || !view?.content) return new Response("This link isn't working.", { status: 404 });

  const format = new URL(request.url).searchParams.get("format") === "html" ? "html" : "md";
  const body = format === "html" ? exportHtml(view.content) : exportMarkdown(view.content);
  return new Response(body, {
    headers: {
      "Content-Type": format === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${view.content.slug}.${format}"`,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
