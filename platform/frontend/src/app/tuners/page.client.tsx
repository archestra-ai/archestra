"use client";

import { PageLayout } from "@/components/page-layout";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { SuggestionsInbox } from "./_parts/suggestions-inbox";
import { TunersPanel } from "./_parts/tuners-panel";

export default function TunersPage() {
  const { data: canUpdate } = useHasPermissions({
    tuner: ["update"],
    log: ["admin"],
  });
  return (
    <PageLayout
      minWidth="phone"
      title="Tuners"
      description="Scheduled agents that review recent activity and suggest improvements."
    >
      <div className="space-y-8">
        <TunersPanel canUpdate={canUpdate} />
        <SuggestionsInbox canUpdate={canUpdate} />
      </div>
    </PageLayout>
  );
}
