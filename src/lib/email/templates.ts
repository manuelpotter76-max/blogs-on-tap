/** Customer email copy. Plain and short; every email carries one link. */

export type EmailContent = { subject: string; html: string; text: string };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function layout(heading: string, paragraphs: string[], button: string, url: string, footer: string): string {
  const ps = paragraphs.map((p) => `<p style="margin:0 0 14px">${esc(p)}</p>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#f7f6f3;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1d1d1b">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
<p style="font-weight:700;margin:0 0 24px">Blogs <span style="color:#b5522b">on Tap</span></p>
<h1 style="font-size:20px;margin:0 0 16px">${esc(heading)}</h1>${ps}
<p style="margin:24px 0"><a href="${esc(url)}" style="background:#b5522b;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${esc(button)}</a></p>
<p style="color:#6b6a66;font-size:13px;margin:0">${esc(footer)}</p>
</div></body></html>`;
}

function text(heading: string, paragraphs: string[], url: string, footer: string): string {
  return [heading, "", ...paragraphs.flatMap((p) => [p, ""]), url, "", footer].join("\n");
}

const FOOTER = "This link is just for you, so please don't forward it. Questions? Just reply to this email.";

export function onboardingInvite(name: string, url: string): EmailContent {
  const heading = `Welcome to Blogs on Tap, ${name}`;
  const ps = [
    "Thanks for signing up. Before we write anything, we need to learn about your business.",
    "The questionnaire takes about 15 minutes. It saves as you go, so you can stop and come back with the same link.",
  ];
  return {
    subject: "Let's get your blog started",
    html: layout(heading, ps, "Start the questionnaire", url, `${FOOTER} The link works for 30 days.`),
    text: text(heading, ps, url, `${FOOTER} The link works for 30 days.`),
  };
}

export function profileReview(name: string, url: string): EmailContent {
  const heading = "Did we get your business right?";
  const ps = [
    `We put together a profile of ${name} from your answers. Every article we write will lean on it.`,
    "Please take a few minutes to check it. Anything we figured out on our own is marked so you can confirm it or take it out.",
  ];
  return {
    subject: "Please check your business profile",
    html: layout(heading, ps, "Review my profile", url, FOOTER),
    text: text(heading, ps, url, FOOTER),
  };
}

export function topicReview(count: number, url: string, round: number): EmailContent {
  const heading = round > 1 ? "A few new topic ideas for you" : "Your first blog topics are ready";
  const ps = [
    `We drafted ${count} article ideas based on your profile.`,
    "Approve the ones you like and skip the rest. Writing starts as soon as you approve.",
  ];
  return {
    subject: round > 1 ? "New topic ideas to review" : "Pick your first blog topics",
    html: layout(heading, ps, "Review topics", url, FOOTER),
    text: text(heading, ps, url, FOOTER),
  };
}

export function articleReady(title: string, url: string, revisedVersion: boolean): EmailContent {
  const heading = revisedVersion ? "Your revised article is ready" : "Your new article is ready";
  const ps = [
    `"${title}" is ready for you.`,
    "Open it to read it, copy it straight into your website, or download it. If anything needs changing, you can ask for edits from the same page.",
  ];
  return {
    subject: revisedVersion ? `Revised: ${title}` : `New article ready: ${title}`,
    html: layout(heading, ps, "Read your article", url, FOOTER),
    text: text(heading, ps, url, FOOTER),
  };
}
