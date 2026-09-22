import { archestraApiSdk, type ErrorExtended } from "@archestra/shared";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ServerErrorFallback } from "@/components/error-fallback";
import { PageLayout } from "@/components/page-layout";
import { getServerApiHeaders } from "@/lib/utils/server";
import { AppaGithubSyncPanel } from "./_parts/appa-github-sync-panel";
import { BatteriesPanel } from "./_parts/batteries-panel";
import { GuardrailsDeploymentToggle } from "./_parts/guardrails-deployment-toggle";
import { GuardrailsPolicyEditor } from "./guardrails-policy-editor";

export const dynamic = "force-dynamic";

export default async function OpenAppaPage() {
  let enabled = false;
  try {
    const headers = await getServerApiHeaders();
    const config = await archestraApiSdk.getConfig({ headers });
    if (config.error) throw config.error;
    enabled = config.data?.features.openappaEnabled === true;
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }
  if (!enabled) notFound();

  return (
    <PageLayout
      title="OpenAPPA"
      description="Edit the policy that governs tool calls and their results."
    >
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">
          <span>
            Using Claude Code? Configure policies here, then install the client
            integration from{" "}
          </span>
          <Link href="/plugins" className="underline underline-offset-4">
            Plugins
          </Link>
          <span>.</span>
        </p>
        <GuardrailsDeploymentToggle />
        <GuardrailsPolicyEditor />
        <AppaGithubSyncPanel />
        <BatteriesPanel />
      </div>
    </PageLayout>
  );
}
