const TZ = "America/New_York";

export function fmtDate(value: string | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" });
}

/** Billing periods come from Zoho as plain dates (stored at midnight UTC), so show them in UTC to avoid a day shift. */
export function fmtDay(value: string | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-US", {
    timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function fmtMoney(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

const STATUS_LABEL: Record<string, string> = {
  pending_payment: "Pending payment",
  active: "Active",
  past_due: "Past due",
  suspended: "Suspended",
  cancel_scheduled: "Cancels at period end",
  cancelled: "Cancelled",
};
export function statusLabel(s: string | null | undefined): string {
  return s ? STATUS_LABEL[s] ?? s : "No subscription";
}

const LEDGER_LABEL: Record<string, string> = {
  grant: "Monthly credits added",
  rollover_in: "Rolled over from last month",
  rollover_out: "Rolled over to next month",
  reserve: "Reserved for an article",
  release: "Returned (article not produced)",
  consume: "Article approved",
  expire: "Expired unused",
  adjust: "Manual adjustment",
};
export function ledgerLabel(kind: string): string {
  return LEDGER_LABEL[kind] ?? kind;
}

const ACTION_LABEL: Record<string, string> = {
  "onboarding.pending": "Waiting to start onboarding",
  "credits.adjust": "Credits adjusted",
  "admin.view_customer": "Viewed by admin",
  "billing.subscription_created": "Subscribed",
  "billing.subscription_activation": "Subscription activated",
  "billing.subscription_renewed": "Renewed",
  "billing.subscription_upgraded": "Upgraded",
  "billing.subscription_downgraded": "Downgraded",
  "billing.subscription_cancelled": "Cancelled",
  "billing.subscription_cancellation_scheduled": "Scheduled to cancel",
  "billing.subscription_reactivated": "Reactivated",
  "billing.subscription_unpaid": "Payment failed",
  "billing.event_stale": "Ignored an out-of-date billing message",
  "onboarding.submitted": "Sent in the questionnaire",
  "onboarding.link_resent": "Onboarding link re-sent",
  "website.fetched": "Read their website",
  "profile.drafted": "Profile drafted by AI",
  "profile.confirmed": "Confirmed their profile",
  "profile.research_rerun": "Profile research re-run",
  "strategy.drafted": "Topic ideas drafted by AI",
  "strategy.more_requested": "More topic ideas requested",
  "strategy.needs_admin": "Skipped every topic batch: needs a person",
  "topics.decided": "Picked topics",
  "task.failed": "A background step failed",
  "task.retried": "Background step retried",
};
export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

/** Article job states, as the admin sees them. */
export const STATE_LABEL: Record<string, string> = {
  queued: "Waiting to start", drafting: "Writing", quality_review: "AI quality check", needs_revision: "AI revising",
  admin_review: "Needs your review", ready_for_customer: "Sending", delivered: "With customer",
  customer_revision_requested: "Customer asked for changes", customer_approved: "Approved by customer", failed: "Failed",
};
