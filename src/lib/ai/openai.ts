import type { Queryable } from "@/lib/db/client";
import { PermanentError } from "@/lib/tasks/queue";
import { validate, type Schema } from "./json-schema";

/**
 * One structured call to the OpenAI Responses API, logged to app.ai_runs with
 * model, prompt version, tokens, cost and source references. Our prompts,
 * schemas and orchestration live in this repo; OpenAI is just the model.
 */
export type InputPart =
  | { type: "input_text"; text: string }
  | { type: "input_file"; filename: string; file_data: string };   // data:application/pdf;base64,...

export type StructuredCall = {
  orgId: string;
  stage: string;
  promptVersion: string;
  model: string;
  instructions: string;
  input: InputPart[];
  schemaName: string;
  schema: Schema;
  sourceRefs?: unknown[];
  taskId?: string | null;
  maxOutputTokens?: number;
};

export type StructuredResult<T> = { runId: string; data: T; costUsd: number | null };

/** Model choice lives in env vars so it can change without a deploy of new code. */
export function modelFor(stage: "research" | "strategy"): string {
  const v = (stage === "research" ? process.env.OPENAI_MODEL_RESEARCH : process.env.OPENAI_MODEL_STRATEGY)?.trim()
    || process.env.OPENAI_MODEL_DEFAULT?.trim();
  if (!v) throw new PermanentError(`Set OPENAI_MODEL_${stage === "research" ? "RESEARCH" : "STRATEGY"} or OPENAI_MODEL_DEFAULT`);
  return v;
}

/** Strip keywords strict mode may not accept; our own validator still enforces them. */
export function toOpenAISchema(s: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: s.type };
  if ("description" in s && s.description) out.description = s.description;
  if ("enum" in s && s.enum) out.enum = s.enum;
  if (s.type === "array") out.items = toOpenAISchema(s.items);
  if (s.type === "object") {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toOpenAISchema(v)]));
    out.required = s.required;
    out.additionalProperties = false;
  }
  return out;
}

type ResponsesApiResult = {
  id?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string } | null;
};

export type Fetcher = typeof fetch;

export async function callStructured<T>(db: Queryable, call: StructuredCall, fetcher: Fetcher = fetch): Promise<StructuredResult<T>> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new PermanentError("OPENAI_API_KEY is not set");

  const { rows } = await db.query<{ id: string }>(
    `insert into app.ai_runs (org_id, stage, prompt_version, model, source_refs, task_id)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [call.orgId, call.stage, call.promptVersion, call.model, JSON.stringify(call.sourceRefs ?? []), call.taskId ?? null]);
  const runId = rows[0].id;

  const finish = async (status: string, fields: { usage?: ResponsesApiResult["usage"]; responseId?: string; error?: string; validation?: string[] }) => {
    const inTok = fields.usage?.input_tokens ?? null;
    const cached = fields.usage?.input_tokens_details?.cached_tokens ?? null;
    const outTok = fields.usage?.output_tokens ?? null;
    const { rows: r } = await db.query<{ cost_usd: string | null }>(
      `update app.ai_runs r set status = $2, input_tokens = $3, cached_input_tokens = $4, output_tokens = $5,
              provider_response_id = $6, error = $7, validation_errors = $8, finished_at = now(),
              cost_usd = (select round(((coalesce($3, 0) - coalesce($4, 0)) * p.input_per_mtok
                                       + coalesce($4, 0) * p.cached_input_per_mtok
                                       + coalesce($5, 0) * p.output_per_mtok) / 1000000.0, 6)
                            from app.ai_model_prices p where p.model = r.model)
        where id = $1 returning cost_usd`,
      [runId, status, inTok, cached, outTok, fields.responseId ?? null, fields.error?.slice(0, 2000) ?? null,
       fields.validation ? JSON.stringify(fields.validation.slice(0, 50)) : null]);
    return r[0]?.cost_usd == null ? null : Number(r[0].cost_usd);
  };

  let res: Response;
  try {
    res = await fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: call.model,
        instructions: call.instructions,
        input: [{ role: "user", content: call.input }],
        text: { format: { type: "json_schema", name: call.schemaName, schema: toOpenAISchema(call.schema), strict: true } },
        max_output_tokens: call.maxOutputTokens ?? 16_000,
        store: false,
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    await finish("failed", { error: `network: ${(err as Error).message}` });
    throw err;   // retryable
  }

  const raw = await res.text();
  let body: ResponsesApiResult = {};
  try {
    body = JSON.parse(raw) as ResponsesApiResult;
  } catch {
    // fall through with empty body
  }
  if (!res.ok) {
    const msg = `OpenAI ${res.status}: ${body.error?.message ?? raw.slice(0, 300)}`;
    await finish("failed", { error: msg });
    if (res.status === 429 || res.status >= 500) throw new Error(msg);
    throw new PermanentError(msg);   // bad request, auth, unknown model: retrying won't help
  }

  const content = (body.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
  const refusal = content.find((c) => c.type === "refusal")?.refusal;
  const text = content.filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
  if (refusal || body.status === "incomplete" || !text) {
    const msg = refusal ? `model refused: ${refusal}` : `incomplete response: ${body.incomplete_details?.reason ?? "no text"}`;
    await finish("failed", { usage: body.usage, responseId: body.id, error: msg });
    throw new Error(msg);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    await finish("invalid_output", { usage: body.usage, responseId: body.id, error: "output was not JSON" });
    throw new Error("model output was not JSON");
  }
  const problems = validate(call.schema, data);
  if (problems.length) {
    await finish("invalid_output", { usage: body.usage, responseId: body.id, validation: problems });
    throw new Error(`model output failed validation: ${problems.slice(0, 3).join("; ")}`);
  }
  const costUsd = await finish("succeeded", { usage: body.usage, responseId: body.id });
  return { runId, data: data as T, costUsd };
}

/** Wrap untrusted text so the model treats it as material, not instructions. */
export function untrusted(label: string, text: string): string {
  const clean = text.replace(/<\/?untrusted[^>]*>/gi, "");
  return `<untrusted source="${label.replace(/"/g, "'")}">\n${clean}\n</untrusted>`;
}
