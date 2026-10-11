import { createHash } from "node:crypto";
import type { Queryable } from "@/lib/db/client";

/**
 * Customer uploads (brand guides, brochures, service sheets) go to a private
 * Supabase Storage bucket through the REST API with the server's secret key.
 * Browsers never talk to storage directly, and every path starts with the org
 * id, so one customer's files can't be addressed through another's link.
 */
export const BUCKET = "customer-files";
export const MAX_FILE_BYTES = 4 * 1024 * 1024;   // Vercel caps request bodies at 4.5 MB
export const MAX_FILES = 5;

const TYPES: Record<string, { mime: string; text: boolean }> = {
  pdf: { mime: "application/pdf", text: false },
  txt: { mime: "text/plain", text: true },
  md: { mime: "text/markdown", text: true },
};

export type UploadCheck =
  | { ok: true; ext: string; mime: string; text: string | null }
  | { ok: false; reason: string };

/** Decide by content, not by the name or type the browser claims. */
export function checkUpload(filename: string, bytes: Uint8Array): UploadCheck {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  const t = TYPES[ext];
  if (!t) return { ok: false, reason: "Please upload a PDF, .txt or .md file." };
  if (bytes.length === 0) return { ok: false, reason: "That file is empty." };
  if (bytes.length > MAX_FILE_BYTES) return { ok: false, reason: "Files can be up to 4 MB." };
  if (ext === "pdf") {
    const head = Buffer.from(bytes.subarray(0, 5)).toString("latin1");
    if (head !== "%PDF-") return { ok: false, reason: "That doesn't look like a real PDF." };
    return { ok: true, ext, mime: t.mime, text: null };
  }
  if (bytes.includes(0)) return { ok: false, reason: "That doesn't look like a text file." };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "That text file isn't UTF-8." };
  }
  return { ok: true, ext, mime: t.mime, text: text.slice(0, 60_000) };
}

function config() {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set for uploads");
  return { url, headers: { apikey: key, Authorization: `Bearer ${key}` } };
}

let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const { url, headers } = config();
  const res = await fetch(`${url}/storage/v1/bucket`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: MAX_FILE_BYTES,
      allowed_mime_types: Object.values(TYPES).map((t) => t.mime) }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (!/already exists|Duplicate/i.test(body)) throw new Error(`Storage bucket ${res.status}: ${body.slice(0, 200)}`);
  }
  bucketReady = true;
}

export async function putObject(path: string, bytes: Uint8Array, mime: string): Promise<void> {
  await ensureBucket();
  const { url, headers } = config();
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": mime, "x-upsert": "true" },
    body: new Uint8Array(bytes),   // copies into a plain ArrayBuffer, which fetch accepts
  });
  if (!res.ok) throw new Error(`Storage upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function getObject(path: string): Promise<Uint8Array> {
  const { url, headers } = config();
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${path}`, { headers });
  if (!res.ok) throw new Error(`Storage download ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function deleteObject(path: string): Promise<void> {
  const { url, headers } = config();
  await fetch(`${url}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: [path] }),
  });
}

export type SaveUploadResult = { ok: true; id: string } | { ok: false; reason: string };

export async function saveUpload(
  db: Queryable, orgId: string, filename: string, bytes: Uint8Array,
  put: typeof putObject = putObject,
): Promise<SaveUploadResult> {
  const check = checkUpload(filename, bytes);
  if (!check.ok) return check;
  const { rows: count } = await db.query<{ n: number }>(
    `select count(*)::int as n from app.source_documents where org_id = $1 and kind = 'upload' and status <> 'removed'`,
    [orgId]);
  if (count[0].n >= MAX_FILES) return { ok: false, reason: `You can add up to ${MAX_FILES} files.` };

  const sha = createHash("sha256").update(bytes).digest("hex");
  const safeName = filename.replace(/[^\w.\- ]+/g, "_").slice(-100) || `file.${check.ext}`;
  const path = `${orgId}/${sha}.${check.ext}`;
  await put(path, bytes, check.mime);
  const { rows } = await db.query<{ id: string }>(
    `insert into app.source_documents (org_id, kind, filename, mime_type, size_bytes, sha256, storage_path, extracted_text)
     values ($1, 'upload', $2, $3, $4, $5, $6, $7)
     on conflict (org_id, sha256) where kind = 'upload' and status <> 'removed' do nothing
     returning id`,
    [orgId, safeName, check.mime, bytes.length, sha, path, check.text]);
  if (!rows.length) return { ok: false, reason: "You already added that file." };
  return { ok: true, id: rows[0].id };
}

export async function removeUpload(db: Queryable, orgId: string, docId: string): Promise<void> {
  await db.query(
    `update app.source_documents set status = 'removed'
      where id = $1 and org_id = $2 and kind = 'upload'`, [docId, orgId]);
}
