import { getDb } from "@/lib/db/client";
import { resolveLink } from "@/lib/links";
import { loadOnboarding } from "@/lib/onboarding/store";
import { CustomerShell, Notice } from "@/app/customer-shell";
import { OnboardingForm } from "./form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Get started | Blogs on Tap" };

export default async function StartPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = await getDb();
  const link = await resolveLink(db, token, "onboarding");
  if (!link) {
    return (
      <CustomerShell>
        <Notice title="This link isn't working">
          It may have expired or been replaced by a newer one. Reply to your welcome email and we'll send you a fresh link.
        </Notice>
      </CustomerShell>
    );
  }

  const state = await loadOnboarding(db, link.org_id);
  if (state.submittedAt) {
    return (
      <CustomerShell>
        <Notice title="Thanks, we've got everything">
          We're putting together your business profile now. You'll get an email within a day asking you to check it.
          Nothing gets written until you've confirmed it.
        </Notice>
      </CustomerShell>
    );
  }

  return (
    <CustomerShell>
      <OnboardingForm token={token} initial={state} />
    </CustomerShell>
  );
}
