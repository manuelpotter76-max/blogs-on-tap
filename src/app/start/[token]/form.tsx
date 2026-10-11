"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  STEPS, FILES_STEP, REVIEW_STEP, TOTAL_STEPS, cleanAnswers, isVisible, stepErrors, type Answers, type Field,
} from "@/lib/onboarding/questions";
import type { OnboardingState } from "@/lib/onboarding/store";
import { removeFileAction, saveAction, submitAction, uploadAction } from "../actions";

type FileRow = OnboardingState["files"][number];

/** Lines fields are edited as plain text and split into a list on save. */
function toDraft(a: Answers): Answers {
  const out: Answers = { ...a };
  for (const s of STEPS) for (const f of s.fields) {
    if (f.type === "lines" && Array.isArray(out[f.key])) out[f.key] = (out[f.key] as string[]).join("\n");
  }
  return out;
}

export function OnboardingForm({ token, initial }: { token: string; initial: OnboardingState }) {
  const [answers, setAnswers] = useState<Answers>(() => toDraft(initial.answers));
  const [step, setStep] = useState(() => Math.min(initial.currentStep, TOTAL_STEPS - 1));
  const [consent, setConsent] = useState(initial.websiteConsent);
  const [files, setFiles] = useState<FileRow[]>(initial.files);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  const dirty = useRef(false);
  const top = useRef<HTMLDivElement>(null);

  const set = (key: string, value: string | string[]) => {
    dirty.current = true;
    setAnswers((a) => ({ ...a, [key]: value }));
    setErrors((e) => {
      const { [key]: _gone, ...rest } = e;
      return rest;
    });
  };

  // Quiet autosave every 30 seconds while they type.
  useEffect(() => {
    const t = setInterval(() => {
      if (!dirty.current) return;
      dirty.current = false;
      void saveAction(token, answers, step, consent);
    }, 30_000);
    return () => clearInterval(t);
  }, [token, answers, step, consent]);

  const go = (to: number, validate: boolean) => {
    if (validate && step < STEPS.length) {
      const errs = stepErrors(step, cleanAnswers(answers));
      if (Object.keys(errs).length) {
        setErrors(errs);
        setMessage({ kind: "err", text: "A couple of things need filling in." });
        return;
      }
    }
    startTransition(async () => {
      const r = await saveAction(token, answers, to, consent);
      dirty.current = false;
      if (!r.ok) {
        setMessage({ kind: "err", text: r.error });
        if (r.closed) setDone(true);
        return;
      }
      setMessage(null);
      setErrors({});
      setStep(to);
      top.current?.scrollIntoView({ behavior: "smooth" });
    });
  };

  const submit = () => {
    startTransition(async () => {
      const r = await submitAction(token, answers, consent);
      if (r.ok || r.closed) {
        setDone(true);
        return;
      }
      setMessage({ kind: "err", text: r.error });
      if (r.step !== undefined) {
        setStep(r.step);
        setErrors(stepErrors(r.step, cleanAnswers(answers)));
      }
    });
  };

  if (done) {
    return (
      <section className="card message">
        <h1>Thanks, we&apos;ve got everything</h1>
        <p>We&apos;re putting together your business profile now. You&apos;ll get an email within a day asking you to
          check it. Nothing gets written until you&apos;ve confirmed it.</p>
      </section>
    );
  }

  const hasSite = Boolean(String(answers.website ?? "").trim() || String(answers.blog_url ?? "").trim());
  const title = step < STEPS.length ? STEPS[step].title : step === FILES_STEP ? "Files and your website" : "Check and send";

  return (
    <div ref={top}>
      <div className="progress" aria-label={`Step ${step + 1} of ${TOTAL_STEPS}`}>
        <div className="progress-bar" style={{ width: `${((step + 1) / TOTAL_STEPS) * 100}%` }} />
      </div>
      <p className="step-count">Step {step + 1} of {TOTAL_STEPS}</p>
      <section className="card">
        <h1>{title}</h1>
        {step < STEPS.length && <p className="sub">{STEPS[step].intro}</p>}
        {message && <p className={`flash ${message.kind}`} role="alert">{message.text}</p>}

        {step < STEPS.length && STEPS[step].fields.filter((f) => isVisible(f, answers)).map((f) => (
          <FieldInput key={f.key} field={f} value={answers[f.key]} error={errors[f.key]} onChange={(v) => set(f.key, v)} />
        ))}

        {step === FILES_STEP && (
          <FilesStep token={token} files={files} setFiles={setFiles} hasSite={hasSite}
            consent={consent} setConsent={(c) => { dirty.current = true; setConsent(c); }} />
        )}

        {step === REVIEW_STEP && <Review answers={answers} files={files} consent={consent && hasSite} onEdit={(s) => go(s, false)} />}

        <div className="nav">
          {step > 0 ? <button type="button" className="secondary" disabled={pending} onClick={() => go(step - 1, false)}>Back</button> : <span />}
          {step < REVIEW_STEP
            ? <button type="button" disabled={pending} onClick={() => go(step + 1, true)}>{pending ? "Saving..." : "Save and continue"}</button>
            : <button type="button" disabled={pending} onClick={submit}>{pending ? "Sending..." : "Send it in"}</button>}
        </div>
      </section>
      <p className="fine">Your answers save as you go. You can close this page and come back with the same link.</p>
    </div>
  );
}

function FieldInput({ field: f, value, error, onChange }: {
  field: Field; value: string | string[] | undefined; error?: string; onChange: (v: string | string[]) => void;
}) {
  const id = `f-${f.key}`;
  const label = <label htmlFor={id}>{f.label}</label>;
  const help = f.help && <p className="help">{f.help}</p>;
  const err = error && <p className="field-error">{error}</p>;
  const str = Array.isArray(value) ? value.join("\n") : value ?? "";

  if (f.type === "multiselect") {
    const sel = new Set(Array.isArray(value) ? value : []);
    return (
      <fieldset className="field">
        <legend>{f.label}</legend>{help}
        <div className="chips">
          {f.options!.map((o) => (
            <label key={o.value} className={`chip ${sel.has(o.value) ? "on" : ""}`}>
              <input type="checkbox" checked={sel.has(o.value)} onChange={(e) => {
                const next = new Set(sel);
                if (e.target.checked) next.add(o.value); else next.delete(o.value);
                onChange([...next]);
              }} />
              {o.label}
            </label>
          ))}
        </div>{err}
      </fieldset>
    );
  }
  if (f.type === "select") {
    return (
      <div className="field">{label}{help}
        <select id={id} value={str} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error}>
          <option value="">Choose one</option>
          {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>{err}
      </div>
    );
  }
  if (f.type === "textarea" || f.type === "lines") {
    return (
      <div className="field">{label}{help}
        <textarea id={id} rows={f.type === "lines" ? 4 : 4} value={str} placeholder={f.placeholder}
          maxLength={f.type === "lines" ? undefined : f.max} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} />
        {err}
      </div>
    );
  }
  return (
    <div className="field">{label}{help}
      <input id={id} type={f.type} value={str} placeholder={f.placeholder} maxLength={f.max}
        onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} />
      {err}
    </div>
  );
}

function FilesStep({ token, files, setFiles, hasSite, consent, setConsent }: {
  token: string; files: FileRow[]; setFiles: (f: FileRow[]) => void; hasSite: boolean;
  consent: boolean; setConsent: (c: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.append("file", file);
    const r = await uploadAction(token, fd);
    setBusy(false);
    if (input.current) input.current.value = "";
    if (!r.ok) setError(r.error);
    else setFiles([...files, r.file]);
  };

  return (
    <>
      <div className="field">
        <label htmlFor="upload">Brand guide, brochure or service sheets (optional)</label>
        <p className="help">PDF, .txt or .md, up to 4 MB each, 5 files at most.</p>
        <input id="upload" ref={input} type="file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
          disabled={busy || files.length >= 5} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        {busy && <p className="help">Uploading...</p>}
        {error && <p className="field-error">{error}</p>}
        {files.length > 0 && (
          <ul className="files">
            {files.map((f) => (
              <li key={f.id}>
                {f.filename} <span className="muted">({Math.max(1, Math.round(f.size_bytes / 1024))} KB)</span>{" "}
                <button type="button" className="link" onClick={async () => {
                  const r = await removeFileAction(token, f.id);
                  if (r.ok) setFiles(files.filter((x) => x.id !== f.id));
                }}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {hasSite ? (
        <label className="consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>Yes, you may read my public website to learn about my business. We only read a handful of public
            pages, respect your robots.txt, and you&apos;ll confirm anything we pick up before we use it.</span>
        </label>
      ) : (
        <p className="help">No website given, so we&apos;ll work from your answers.</p>
      )}
    </>
  );
}

function Review({ answers, files, consent, onEdit }: {
  answers: Answers; files: FileRow[]; consent: boolean; onEdit: (step: number) => void;
}) {
  const clean = cleanAnswers(answers);
  return (
    <div className="review">
      <p className="sub">Have a quick look. Once you send it, we start building your profile.</p>
      {STEPS.map((s, i) => (
        <div key={s.id} className="review-step">
          <div className="review-head"><h2>{s.title}</h2><button type="button" className="link" onClick={() => onEdit(i)}>Edit</button></div>
          <dl>
            {s.fields.filter((f) => isVisible(f, clean)).map((f) => {
              const v = clean[f.key];
              const shown = Array.isArray(v)
                ? (f.options ? v.map((x) => f.options!.find((o) => o.value === x)?.label ?? x) : v).join(", ")
                : f.options ? f.options.find((o) => o.value === v)?.label ?? "" : v;
              return shown ? <div key={f.key}><dt>{f.label}</dt><dd>{shown}</dd></div> : null;
            })}
          </dl>
        </div>
      ))}
      <div className="review-step">
        <div className="review-head"><h2>Files and website</h2><button type="button" className="link" onClick={() => onEdit(FILES_STEP)}>Edit</button></div>
        <dl>
          <div><dt>Files</dt><dd>{files.length ? files.map((f) => f.filename).join(", ") : "None"}</dd></div>
          <div><dt>Read my website</dt><dd>{consent ? "Yes" : "No"}</dd></div>
        </dl>
      </div>
    </div>
  );
}
