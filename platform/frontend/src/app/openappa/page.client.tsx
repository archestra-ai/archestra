"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { ShieldCheck } from "lucide-react";
import { OpenAppaIcon } from "@/components/openappa-icon";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useGuardrailsDeployment } from "@/lib/guardrails-deployment.query";
import { useGuardrailsPolicy } from "@/lib/guardrails-policy.query";
import { usePolicyDeclarations } from "@/lib/openappa-batteries.query";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { BatteriesTab } from "./_parts/batteries-tab";
import { TonedBadge } from "./_parts/coverage-badges";
import { GuardrailsDeploymentToggle } from "./_parts/guardrails-deployment-toggle";
import { OPENAPPA_SPEC, SpecLink } from "./_parts/openappa-links";
import {
  OPENAPPA_TABS,
  OpenappaNavigationProvider,
  type OpenappaTab,
  openappaTabHref,
  useOpenappaNavigation,
} from "./_parts/openappa-navigation";
import { OverviewTab } from "./_parts/overview-tab";
import { PolicyTab } from "./_parts/policy-tab";
import { ServerDialog } from "./_parts/server-dialog";
import { ToolsTab } from "./_parts/tools-tab";

const TAB_DESCRIPTIONS: Record<OpenappaTab, string> = {
  overview:
    "Which servers the policy governs, who can reach them, and how strict it is.",
  tools:
    "Every installed tool, who governs it, and what happens when an agent calls it.",
  batteries:
    "Rule packages the policy includes, the servers they govern, and the ones still available.",
  policy:
    "The policy text, where it is synced from, and the document the runtime enforces.",
};

export default function OpenappaPage() {
  return (
    <OpenappaNavigationProvider>
      <OpenappaPageContent />
    </OpenappaNavigationProvider>
  );
}

function OpenappaPageContent() {
  const { tab } = useOpenappaNavigation();
  return (
    <PageLayout
      title={
        <span className="flex items-center gap-2">
          <OpenAppaIcon aria-hidden className="size-6" />
          <span>OpenAPPA</span>
        </span>
      }
      documentTitle="OpenAPPA"
      description={TAB_DESCRIPTIONS[tab]}
      status={<PolicyStatus />}
      actionButton={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <SpecLink
            href={getDocsUrl(
              DocsPage.PlatformAiToolGuardrails,
              "guardrails-v2-preview",
            )}
          >
            Platform docs
          </SpecLink>
          <SpecLink href={OPENAPPA_SPEC.contracts}>
            Policy specification
          </SpecLink>
          <GuardrailsDeploymentToggle variant="compact" />
        </div>
      }
      tabs={OPENAPPA_TABS.map((entry) => ({
        label: entry.label,
        href: openappaTabHref(entry.value),
        testId: `openappa-tab-${entry.value}`,
        // Selection lives in a query parameter, which `PageLayout` cannot
        // read from an href alone.
        selected: entry.value === tab,
      }))}
      mobileVisibleCount={OPENAPPA_TABS.length}
    >
      {tab === "overview" && <OverviewTab />}
      {tab === "tools" && <ToolsTab />}
      {tab === "batteries" && <BatteriesTab />}
      {tab === "policy" && <PolicyTab />}
      <ServerDialog />
    </PageLayout>
  );
}

/**
 * Whether the runtime enforces the policy, and which revision: the switch and
 * the feature flag say whether, the declarations say whether the latest text
 * composed or the one before it is still in force, and the policy and the
 * sync say where the text came from.
 */
function PolicyStatus() {
  const deployment = useGuardrailsDeployment();
  const policy = useGuardrailsPolicy();
  const declarations = usePolicyDeclarations();
  const sync = useAppaGithubSync();
  if (
    deployment.isPending ||
    policy.isPending ||
    declarations.isPending ||
    sync.isPending
  )
    return <Skeleton className="h-6 w-48" />;
  if (!deployment.data || !policy.data || !declarations.data || !sync.data)
    return (
      <Badge variant="destructive">
        <span>Status unavailable</span>
      </Badge>
    );
  const { enabled, featureEnabled } = deployment.data;
  const { revision, updatedAt } = policy.data;
  const { rootRevision, lastError, managedInGithub } = declarations.data;
  const refused = lastError !== null;
  const pulledAt = sync.data.source?.lastSyncedAt ?? null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!featureEnabled ? (
        <TonedBadge tone="critical">
          <span>Feature flag off</span>
        </TonedBadge>
      ) : refused ? (
        <TonedBadge tone="critical">
          <span>{`Enforcing revision ${rootRevision}`}</span>
        </TonedBadge>
      ) : !enabled ? (
        <TonedBadge tone="warning">
          <span>Not enforcing</span>
        </TonedBadge>
      ) : (
        <TonedBadge tone="ok">
          <ShieldCheck aria-hidden />
          <span>Enforcing</span>
        </TonedBadge>
      )}
      <span
        data-testid="policy-revision"
        className={
          refused ? "text-sm text-destructive" : "text-sm text-muted-foreground"
        }
      >
        {refused
          ? `Revision ${revision} refused, ${rootRevision} still enforced`
          : revision === 0
            ? "Not yet saved"
            : managedInGithub && pulledAt
              ? `Revision ${revision} · pulled ${formatRelativeTimeFromNow(pulledAt)} from GitHub`
              : updatedAt
                ? `Revision ${revision} · saved ${formatRelativeTimeFromNow(updatedAt)}`
                : `Revision ${revision}`}
      </span>
    </div>
  );
}
