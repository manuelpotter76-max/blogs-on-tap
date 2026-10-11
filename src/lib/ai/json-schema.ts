/**
 * The small JSON Schema subset our agent contracts use, plus a validator for
 * it. OpenAI's strict structured outputs already enforce these schemas; we
 * validate again because model output is untrusted input to our database.
 */
export type Schema =
  | { type: "string"; enum?: string[]; description?: string; maxLength?: number }
  | { type: ["string", "null"]; description?: string }
  | { type: "integer"; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string }
  | { type: "array"; items: Schema; description?: string; minItems?: number; maxItems?: number }
  | { type: "object"; properties: Record<string, Schema>; required: string[]; additionalProperties: false; description?: string };

export const str = (description?: string): Schema => ({ type: "string", ...(description ? { description } : {}) });
export const nullableStr = (description?: string): Schema => ({ type: ["string", "null"], ...(description ? { description } : {}) });
export const int = (description?: string, minimum?: number, maximum?: number): Schema =>
  ({ type: "integer", ...(description ? { description } : {}), ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}) });
export const bool = (description?: string): Schema => ({ type: "boolean", ...(description ? { description } : {}) });
export const oneOf = (values: string[], description?: string): Schema => ({ type: "string", enum: values, ...(description ? { description } : {}) });
export const arr = (items: Schema, description?: string, maxItems?: number): Schema =>
  ({ type: "array", items, ...(description ? { description } : {}), ...(maxItems ? { maxItems } : {}) });
/** Every property required, no extras: what strict structured outputs demand. */
export const obj = (properties: Record<string, Schema>, description?: string): Schema =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false, ...(description ? { description } : {}) });

/** Returns a list of problems; empty means valid. */
export function validate(schema: Schema, value: unknown, path = "$"): string[] {
  const t = schema.type;
  if (Array.isArray(t)) {
    if (value === null || typeof value === "string") return [];
    return [`${path}: expected string or null`];
  }
  switch (t) {
    case "string":
      if (typeof value !== "string") return [`${path}: expected string`];
      if ("enum" in schema && schema.enum && !schema.enum.includes(value)) return [`${path}: "${value}" not allowed`];
      return [];
    case "integer":
      if (!Number.isInteger(value)) return [`${path}: expected integer`];
      if ("minimum" in schema && schema.minimum !== undefined && (value as number) < schema.minimum) return [`${path}: below ${schema.minimum}`];
      if ("maximum" in schema && schema.maximum !== undefined && (value as number) > schema.maximum) return [`${path}: above ${schema.maximum}`];
      return [];
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path}: expected boolean`];
    case "array": {
      if (!Array.isArray(value)) return [`${path}: expected array`];
      const s = schema as Extract<Schema, { type: "array" }>;
      const errs = value.flatMap((v, i) => validate(s.items, v, `${path}[${i}]`));
      if (s.maxItems && value.length > s.maxItems) errs.push(`${path}: more than ${s.maxItems} items`);
      return errs;
    }
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path}: expected object`];
      const s = schema as Extract<Schema, { type: "object" }>;
      const v = value as Record<string, unknown>;
      const errs: string[] = [];
      for (const k of s.required) if (!(k in v)) errs.push(`${path}.${k}: missing`);
      for (const k of Object.keys(v)) {
        if (!(k in s.properties)) errs.push(`${path}.${k}: unexpected`);
        else errs.push(...validate(s.properties[k], v[k], `${path}.${k}`));
      }
      return errs;
    }
  }
}
