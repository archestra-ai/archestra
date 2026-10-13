import { DocsPage } from "@archestra/shared";
import { Info } from "lucide-react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { InlineNoticeDetails } from "@/components/ui/inline-notice-details";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useK8sCapabilities } from "@/lib/environment.query";

/** Shared runtime availability notice for the agent catalog and settings. */
export function AgentRuntimeUnavailableNotice({
  className,
}: {
  className?: string;
}) {
  // Capability inspection requires environment:update.
  const { data: canInspectCluster } = useHasPermissions({
    environment: ["update"],
  });
  const { data: capabilities } = useK8sCapabilities(canInspectCluster === true);
  const missingResources = capabilities?.agentSandbox?.missingResources ?? [];
  const setupDocsUrl = getFrontendDocsUrl(
    `${DocsPage.PlatformAgentRuntime}/setup`,
    "cluster-prerequisites",
  );
  const diagnostics = missingResources.length
    ? `Missing API resources:\n${missingResources.join("\n")}`
    : capabilities?.agentSandbox?.message;

  return (
    <InlineNotice variant="info" className={className}>
      <Info />
      <InlineNoticeText>
        <span className="font-medium">Agent Runtime unavailable.</span>{" "}
        <span>
          {canInspectCluster
            ? "The Agent Sandbox controller is not installed."
            : "Ask an administrator to install the Agent Sandbox controller."}
        </span>
      </InlineNoticeText>
      {canInspectCluster && (
        <span className="ml-auto" data-slot="inline-notice-action">
          <ExternalDocsLink
            href={setupDocsUrl}
            className="underline underline-offset-2"
          >
            Install controller
          </ExternalDocsLink>
        </span>
      )}
      {canInspectCluster && diagnostics && (
        <InlineNoticeDetails>{diagnostics}</InlineNoticeDetails>
      )}
    </InlineNotice>
  );
}
