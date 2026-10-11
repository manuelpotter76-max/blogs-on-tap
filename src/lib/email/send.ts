import type { Queryable } from "@/lib/db/client";

/**
 * Outbound customer email. EMAIL_PROVIDER picks the sender:
 *   zeptomail  Zoho ZeptoMail transactional API (production)
 *   log        writes the message to the server log only (development, or
 *              before ZeptoMail is set up; links can be copied from /admin)
 *
 * Every email has a dedupe key. A key is sent at most once: the row is written
 * as 'sending' before the provider call, so a crash mid-send leaves it marked
 * 'uncertain' for an admin to check instead of risking a duplicate.
 */
export type OutboundEmail = {
  orgId: string;
  kind: string;
  dedupeKey: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  linkId?: string | null;
};

export type SendResult = "sent" | "already_sent" | "uncertain";

type Provider = { name: string; send(m: OutboundEmail): Promise<string | null> };

function provider(): Provider {
  const name = (process.env.EMAIL_PROVIDER ?? "log").trim();
  if (name === "zeptomail") return zeptomail;
  if (name === "log") return logOnly;
  throw new Error(`Unknown EMAIL_PROVIDER "${name}"`);
}

const logOnly: Provider = {
  name: "log",
  async send(m) {
    console.log(`[email:log] to=${m.to} subject="${m.subject}"\n${m.text}`);
    return null;
  },
};

const zeptomail: Provider = {
  name: "zeptomail",
  async send(m) {
    const token = process.env.ZEPTOMAIL_TOKEN?.trim();
    const from = process.env.EMAIL_FROM?.trim();
    if (!token || !from) throw new Error("ZEPTOMAIL_TOKEN and EMAIL_FROM must be set");
    const url = process.env.ZEPTOMAIL_API_URL?.trim() || "https://api.zeptomail.com/v1.1/email";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: token.startsWith("Zoho-enczapikey") ? token : `Zoho-enczapikey ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        from: { address: from, name: process.env.EMAIL_FROM_NAME?.trim() || "Blogs on Tap" },
        to: [{ email_address: { address: m.to } }],
        reply_to: process.env.EMAIL_REPLY_TO ? [{ address: process.env.EMAIL_REPLY_TO.trim() }] : undefined,
        subject: m.subject,
        htmlbody: m.html,
        textbody: m.text,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`ZeptoMail ${res.status}: ${body.slice(0, 300)}`);
    try {
      return (JSON.parse(body) as { request_id?: string }).request_id ?? null;
    } catch {
      return null;
    }
  },
};

export async function sendEmail(db: Queryable, m: OutboundEmail): Promise<SendResult> {
  const p = provider();
  const { rows } = await db.query<{ id: string }>(
    `insert into app.notifications (org_id, kind, dedupe_key, to_email, subject, link_id, provider)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (dedupe_key) do nothing returning id`,
    [m.orgId, m.kind, m.dedupeKey, m.to, m.subject, m.linkId ?? null, p.name]);

  let id = rows[0]?.id;
  if (!id) {
    const prev = (await db.query<{ id: string; status: string }>(
      `select id, status from app.notifications where dedupe_key = $1`, [m.dedupeKey])).rows[0];
    if (prev.status === "sent") return "already_sent";
    if (prev.status === "sending" || prev.status === "uncertain") {
      // A previous attempt may have reached the provider. Do not risk a duplicate.
      await db.query(`update app.notifications set status = 'uncertain' where id = $1`, [prev.id]);
      return "uncertain";
    }
    // 'failed' means the provider rejected it: safe to try again.
    await db.query(`update app.notifications set status = 'sending', error = null, provider = $2 where id = $1`,
      [prev.id, p.name]);
    id = prev.id;
  }

  try {
    const messageId = await p.send(m);
    await db.query(
      `update app.notifications set status = 'sent', sent_at = now(), provider_message_id = $2 where id = $1`,
      [id, messageId]);
    return "sent";
  } catch (err) {
    const e = err as Error;
    // A timeout or dropped connection may still have been delivered.
    const maybeDelivered = e.name === "TimeoutError" || e.name === "AbortError" || e instanceof TypeError;
    await db.query(`update app.notifications set status = $3, error = $2 where id = $1`,
      [id, e.message.slice(0, 1000), maybeDelivered ? "uncertain" : "failed"]);
    if (maybeDelivered) return "uncertain";
    throw err;
  }
}
