import { DocsPage } from "@archestra/shared";
import { Info } from "lucide-react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useK8sCapabilities } from "@/lib/environment.query";

/**
 * Explains why dedicated runtimes are unavailable: the cluster does not serve
 * the Agent Sandbox API. Administrators who can inspect the cluster see which
 * resources are missing and how to install the controller; everyone else is
 * pointed at them.
 */
export function AgentRuntimeUnavailableNotice({
  className,
}: {
  className?: string;
}) {
  // Reading capabilities needs environment:update, so the query is gated on
  // the same permission to keep it from 403-ing for everyone else.
  const { data: canInspectCluster } = useHasPermissions({
    environment: ["update"],
  });
  const { data: capabilities } = useK8sCapabilities(canInspectCluster === true);
  const missingResources = capabilities?.agentSandbox?.missingResources ?? [];
  const setupDocsUrl = getFrontendDocsUrl(
    `${DocsPage.PlatformAgentRuntime}/setup`,
    "cluster-prerequisites",
  );

  return (
    <Alert variant="info" className={className}>
      <Info />
      <AlertTitle>Agent Runtime is not available</AlertTitle>
      <AlertDescription>
        {canInspectCluster ? (
          <div className="space-y-2">
            <p>
              These agents run in a dedicated runtime, which needs the Agent
              Sandbox controller. This cluster does not have it installed.{" "}
              <ExternalDocsLink href={setupDocsUrl}>
                Install the controller
              </ExternalDocsLink>
            </p>
            {missingResources.length > 0 ? (
              <div>
                <p>Missing resources:</p>
                <ul className="list-disc pl-5">
                  {missingResources.map((resource) => (
                    <li key={resource}>
                      <code className="text-xs">{resource}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p>The agents become available without a restart.</p>
          </div>
        ) : (
          <p>
            These agents run in a dedicated runtime, which is not set up on this
            deployment. Ask an administrator to install the Agent Sandbox
            controller.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}
