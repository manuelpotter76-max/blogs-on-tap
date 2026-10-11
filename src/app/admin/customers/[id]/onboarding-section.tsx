import type { OnboardingOverview } from "@/lib/admin/onboarding";
import { fmtDateTime } from "@/lib/admin/format";
import { TOTAL_STEPS } from "@/lib/onboarding/questions";
import { onboardingAction } from "../../actions";

const STEP_LABEL: Record<string, string> = {
  researching: "AI is researching", awaiting_customer: "Waiting for the customer", confirmed: "Confirmed",
  generating: "AI is drafting topics", approved: "Approved, ready for writing", needs_admin: "Needs you",
};
const TASK_LABEL: Record<string, string> = {
  send_onboarding_invite: "Email: onboarding link", website_fetch: "Read website", business_research: "AI: business research",
  send_profile_review: "Email: check profile", content_strategy: "AI: topic ideas", send_topic_review: "Email: pick topics",
};
const LINK_LABEL: Record<string, string> = { onboarding: "Questionnaire", profile_review: "Profile check", topic_review: "Topic picks" };
const ONB_MESSAGE: Record<string, { kind: "ok" | "err"; text: string }> = {
  ok: { kind: "ok", text: "Done. The worker picks it up within a minute." },
  not_allowed: { kind: "err", text: "That isn't possible at this stage." },
  not_found: { kind: "err", text: "Couldn't find that." },
};

function Btn({ orgId, action, taskId, children }: { orgId: string; action: string; taskId?: string; children: string }) {
  return (
    <form action={onboardingAction} style={{ display: "inline" }}>
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="action" value={action} />
      {taskId && <input type="hidden" name="taskId" value={taskId} />}
      <button type="submit" className="ghost">{children}</button>
    </form>
  );
}

export function OnboardingSection({ orgId, o, flash }: { orgId: string; o: OnboardingOverview; flash?: string }) {
  const msg = flash ? ONB_MESSAGE[flash] : undefined;
  const onbStatus = !o.onboarding
    ? "Not started"
    : o.onboarding.submitted_at
      ? `Sent in ${fmtDateTime(o.onboarding.submitted_at)}${o.onboarding.website_consent ? ", website OK to read" : ""}`
      : `In progress, step ${o.onboarding.current_step + 1} of ${TOTAL_STEPS} (last saved ${fmtDateTime(o.onboarding.updated_at)})`;
  const counts = o.topicCounts;
  const p = o.profile?.data;

  return (
    <>
      <h2 id="onboarding">Onboarding and strategy</h2>
      {msg && <p className={`notice ${msg.kind}`}>{msg.text}</p>}
      <div className="panel">
        <table>
          <tbody>
            <tr><th>Questionnaire</th><td className="wrap-text">{onbStatus}</td>
              <td>{!o.onboarding?.submitted_at && <Btn orgId={orgId} action="resend_invite">Send a fresh link</Btn>}</td></tr>
            <tr><th>Business profile</th><td className="wrap-text">
              {o.profile ? `${STEP_LABEL[o.profile.status] ?? o.profile.status} (version ${o.profile.current_version ?? "-"})` : "-"}</td>
              <td>{o.profile && o.profile.status !== "confirmed" && o.onboarding?.submitted_at &&
                <Btn orgId={orgId} action="rerun_research">Re-run research</Btn>}</td></tr>
            <tr><th>Topics</th><td className="wrap-text">
              {o.strategy ? `${STEP_LABEL[o.strategy.status] ?? o.strategy.status}. ` : ""}
              {counts.proposed ?? 0} waiting on customer, {counts.approved ?? 0} approved, {counts.in_production ?? 0} in production,
              {" "}{counts.used ?? 0} used, {counts.rejected ?? 0} skipped</td>
              <td>{o.profile?.status === "confirmed" && <Btn orgId={orgId} action="more_topics">Draft more topics</Btn>}</td></tr>
            <tr><th>AI spend so far</th><td>${o.aiTotalUsd.toFixed(4)}</td><td /></tr>
          </tbody>
        </table>
      </div>

      {o.links.length > 0 && (
        <>
          <h2>Customer links</h2>
          <div className="panel">
            <table>
              <thead><tr><th>Link</th><th>Expires</th><th>Address (copy if an email didn't arrive)</th></tr></thead>
              <tbody>
                {o.links.map((l) => (
                  <tr key={l.purpose}><td>{LINK_LABEL[l.purpose]}</td><td>{fmtDateTime(l.expires_at)}</td>
                    <td><input readOnly value={l.url} style={{ width: 420 }} /></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {p && (
        <>
          <h2>Profile (version {o.profile?.current_version})</h2>
          <div className="panel">
            <table>
              <tbody>
                <tr><th>Summary</th><td className="wrap-text">{p.summary}</td></tr>
                <tr><th>Services</th><td className="wrap-text">{p.services.map((s) => `${s.name}${s.needs_confirmation ? " (unconfirmed)" : ""}`).join(", ")}</td></tr>
                <tr><th>Area</th><td className="wrap-text">{p.service_area ?? p.service_area_type}</td></tr>
                <tr><th>Voice</th><td className="wrap-text">{[...p.voice.tone, ...p.voice.style_notes].join("; ")}</td></tr>
                <tr><th>Call to action</th><td className="wrap-text">{p.cta.text} → {p.cta.destination}</td></tr>
                <tr><th>Never claim</th><td className="wrap-text">{p.prohibited_claims.join("; ") || "-"}</td></tr>
                <tr><th>Regulated</th><td className="wrap-text">{p.compliance.regulated_field}{p.compliance.notes.length ? `: ${p.compliance.notes.join("; ")}` : ""}</td></tr>
                {p.open_questions.length > 0 && <tr><th>Open questions</th><td className="wrap-text">{p.open_questions.join("; ")}</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {o.topics.length > 0 && (
        <>
          <h2>Topics</h2>
          <div className="panel">
            <table>
              <thead><tr><th>Title</th><th>Keyword</th><th>Status</th><th>Customer note</th></tr></thead>
              <tbody>
                {o.topics.map((t) => (
                  <tr key={t.id}><td className="wrap-text">{t.title}</td><td className="wrap-text">{t.primary_keyword}</td>
                    <td><span className="pill">{t.status.replace("_", " ")}</span></td><td className="wrap-text">{t.customer_note ?? ""}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {o.files.length > 0 && (
        <>
          <h2>Sources</h2>
          <div className="panel">
            <table>
              <thead><tr><th>Type</th><th>Name</th><th>Size</th><th>Status</th></tr></thead>
              <tbody>
                {o.files.map((f, i) => (
                  <tr key={i}><td>{f.kind === "upload" ? "Upload" : "Web page"}</td>
                    <td className="wrap-text">{f.filename ?? f.source_url}</td>
                    <td className="num">{f.size_bytes ? `${Math.max(1, Math.round(f.size_bytes / 1024))} KB` : ""}</td>
                    <td>{f.status}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>Background steps</h2>
      <div className="panel">
        {o.tasks.length === 0 ? <p className="empty">Nothing yet.</p> : (
          <table>
            <thead><tr><th>Step</th><th>State</th><th>Tries</th><th>Last update</th><th>Error</th><th /></tr></thead>
            <tbody>
              {o.tasks.map((t) => (
                <tr key={t.id}>
                  <td>{TASK_LABEL[t.kind] ?? t.kind}</td>
                  <td><span className={`pill ${t.state === "failed" ? "cancelled" : t.state === "done" ? "active" : ""}`}>{t.state}</span></td>
                  <td className="num">{t.attempts}</td>
                  <td>{fmtDateTime(t.updated_at)}</td>
                  <td className="wrap-text" style={{ maxWidth: 380 }}>{t.last_error ?? ""}</td>
                  <td>{t.state === "failed" && <Btn orgId={orgId} action="retry_task" taskId={t.id}>Retry</Btn>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {o.emails.length > 0 && (
        <>
          <h2>Emails</h2>
          <div className="panel">
            <table>
              <thead><tr><th>When</th><th>What</th><th>To</th><th>Status</th><th>Error</th></tr></thead>
              <tbody>
                {o.emails.map((e, i) => (
                  <tr key={i}><td>{fmtDateTime(e.created_at)}</td><td>{e.kind.replace(/_/g, " ")}</td><td>{e.to_email}</td>
                    <td><span className={`pill ${e.status === "sent" ? "active" : e.status === "uncertain" ? "past_due" : e.status === "failed" ? "cancelled" : ""}`}>
                      {e.status}{e.provider === "log" ? " (log only)" : ""}</span></td>
                    <td className="wrap-text">{e.status === "uncertain" ? "May not have arrived. Copy the link above and send it yourself." : e.error ?? ""}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {o.aiRuns.length > 0 && (
        <>
          <h2>AI runs</h2>
          <div className="panel">
            <table>
              <thead><tr><th>When</th><th>Stage</th><th>Model</th><th>Prompt</th><th>Status</th><th>Tokens in/out</th><th>Cost</th></tr></thead>
              <tbody>
                {o.aiRuns.map((r, i) => (
                  <tr key={i}><td>{fmtDateTime(r.started_at)}</td><td>{r.stage.replace("_", " ")}</td><td>{r.model}</td>
                    <td>{r.prompt_version}</td><td title={r.error ?? ""}>{r.status}</td>
                    <td className="num">{r.input_tokens ?? "-"} / {r.output_tokens ?? "-"}</td>
                    <td className="num">{r.cost_usd ? `$${Number(r.cost_usd).toFixed(4)}` : "no price set"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
