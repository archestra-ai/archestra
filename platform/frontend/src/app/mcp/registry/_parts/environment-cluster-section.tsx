"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Info,
  Loader2,
  PlugZap,
} from "lucide-react";
import { useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SecretTextarea } from "@/components/ui/secret-input";
import { getConfiguredApiBaseUrls } from "@/lib/config/config";
import {
  type EnvironmentWithAssignedCount,
  useTestEnvironmentCluster,
} from "@/lib/environment.query";
import {
  chooseEnvironmentCluster,
  ENVIRONMENT_CLUSTER_CHECK_LABELS,
  type EnvironmentClusterCheck,
  type EnvironmentClusterDraft,
  suggestedAgentRuntimePlatformUrl,
} from "@/lib/environment-cluster";
import { useAppName } from "@/lib/hooks/use-app-name";

const CLUSTER_DOCS_URL = getDocsUrl(
  DocsPage.PlatformEnvironments,
  "deploy-into-another-cluster",
);

const PLATFORM_CLUSTER = "platform";
const OWN_CLUSTER = "own";

/**
 * The "Kubernetes cluster" section of the environment editor: which cluster
 * the environment's MCP servers, code sandbox and Agent Runtime sessions are
 * deployed into.
 *
 * The cluster is chosen when the environment is created and never changes.
 * Afterwards only the credential for that same cluster can be replaced.
 */
export function EnvironmentClusterSection({
  mode,
  environment,
  draft,
  onDraftChange,
  namespace,
  disabled,
}: {
  mode: "create" | "edit";
  environment: EnvironmentWithAssignedCount | null;
  draft: EnvironmentClusterDraft;
  onDraftChange: (draft: EnvironmentClusterDraft) => void;
  /** The namespace entered in the General section; the test checks it. */
  namespace: string;
  disabled: boolean;
}) {
  const appName = useAppName();
  const testCluster = useTestEnvironmentCluster();
  // Editing: the field for a replacement credential stays closed until asked for.
  const [replacingCredential, setReplacingCredential] = useState(false);

  const server = environment?.kubeconfigServer ?? null;
  const set = (patch: Partial<EnvironmentClusterDraft>) => {
    onDraftChange({ ...draft, ...patch });
    testCluster.reset();
  };

  if (mode === "edit" && server === null) {
    return (
      <InlineNotice variant="neutral">
        <Info />
        <InlineNoticeBody>
          <span className="font-medium">
            Deploys into the cluster {appName} runs in
          </span>
          <InlineNoticeText>
            The cluster of an environment is chosen when the environment is
            created. To deploy into another cluster, create a new environment.
          </InlineNoticeText>
        </InlineNoticeBody>
      </InlineNotice>
    );
  }

  const trimmedNamespace = namespace.trim();
  const hasKubeconfig = draft.kubeconfig.trim() !== "";
  const canTest =
    trimmedNamespace !== "" && (mode === "edit" || hasKubeconfig) && !disabled;
  const runTest = () =>
    testCluster.mutate({
      environmentId: mode === "edit" ? environment?.id : undefined,
      kubeconfig: hasKubeconfig ? draft.kubeconfig : undefined,
      namespace: trimmedNamespace,
      agentRuntimePlatformBaseUrl:
        draft.agentRuntimePlatformBaseUrl.trim() || null,
    });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Where the MCP servers, code sandbox and Agent Runtime sessions of this
        environment run.{" "}
        <ExternalDocsLink
          href={CLUSTER_DOCS_URL}
          className="underline"
          showIcon={false}
        >
          Learn more
        </ExternalDocsLink>
      </p>

      {mode === "create" && (
        <RadioGroup
          value={draft.ownCluster ? OWN_CLUSTER : PLATFORM_CLUSTER}
          onValueChange={(value) => {
            onDraftChange(
              chooseEnvironmentCluster(
                draft,
                value === OWN_CLUSTER,
                suggestedAgentRuntimePlatformUrl(getConfiguredApiBaseUrls()),
              ),
            );
            testCluster.reset();
          }}
          disabled={disabled}
          className="gap-2.5"
        >
          <ClusterChoice
            value={PLATFORM_CLUSTER}
            label={`The cluster ${appName} runs in`}
            description="The default. Nothing else to set up."
          />
          <ClusterChoice
            value={OWN_CLUSTER}
            label="Another cluster"
            description="Deploy through a kubeconfig. It cannot be changed to a different cluster later."
          />
        </RadioGroup>
      )}

      {mode === "edit" && server !== null && (
        <div className="space-y-2">
          <Label htmlFor="environment-cluster-server">API server</Label>
          <Input
            id="environment-cluster-server"
            value={server}
            readOnly
            className="font-mono"
          />
          <FieldDescription>
            The cluster of an environment cannot be changed. To deploy into
            another cluster, create a new environment.
          </FieldDescription>
        </div>
      )}

      {draft.ownCluster && (
        <>
          {mode === "create" || replacingCredential ? (
            <div className="space-y-2">
              <Label htmlFor="environment-kubeconfig">
                {mode === "create" ? (
                  <>
                    Kubeconfig <span className="text-destructive">*</span>
                  </>
                ) : (
                  <span>New kubeconfig for the same cluster</span>
                )}
              </Label>
              <SecretTextarea
                id="environment-kubeconfig"
                value={draft.kubeconfig}
                onChange={(event) => set({ kubeconfig: event.target.value })}
                rows={6}
                className="max-h-48 font-mono text-xs"
                placeholder={"apiVersion: v1\nkind: Config\nclusters: …"}
                disabled={disabled}
              />
              <FieldDescription>
                Paste the kubeconfig that the workloads Helm chart prints after
                you install it in that cluster. It must hold a token or a client
                certificate; credential plugins and file paths are not accepted.
                It is stored as a secret and never shown again.
              </FieldDescription>
            </div>
          ) : (
            <div className="space-y-2">
              <Label>Credential</Label>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setReplacingCredential(true)}
                  disabled={disabled}
                >
                  Replace credentials
                </Button>
              </div>
              <FieldDescription>
                Use this when the token or certificate was rotated. Running
                workloads are not redeployed.
              </FieldDescription>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="environment-platform-url">
              {appName} URL for Agent Runtime
            </Label>
            <Input
              id="environment-platform-url"
              value={draft.agentRuntimePlatformBaseUrl}
              onChange={(event) =>
                set({ agentRuntimePlatformBaseUrl: event.target.value })
              }
              placeholder="https://platform.example.com"
              className="font-mono"
              disabled={disabled}
            />
            <FieldDescription>
              The address at which pods in that cluster reach {appName}. Agent
              Runtime sessions call it. It starts as {appName}&apos;s external
              API address; change it if that cluster reaches {appName} at
              another address. Leave empty when no agents run in this
              environment.
            </FieldDescription>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={runTest}
                disabled={!canTest || testCluster.isPending}
              >
                {testCluster.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <PlugZap className="h-4 w-4" />
                )}
                <span>Test connection</span>
              </Button>
              {trimmedNamespace === "" && (
                <span className="text-xs text-muted-foreground">
                  Enter the namespace in General first.
                </span>
              )}
            </div>
            {testCluster.data && (
              <ClusterCheckList
                server={testCluster.data.server}
                namespace={trimmedNamespace}
                checks={testCluster.data.checks}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ClusterChoice({
  value,
  label,
  description,
}: {
  value: string;
  label: string;
  description: string;
}) {
  const id = `environment-cluster-${value}`;
  return (
    <div className="flex items-start gap-2.5">
      <RadioGroupItem value={value} id={id} className="mt-1" />
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

const CHECK_STATUS_ICONS: Record<
  EnvironmentClusterCheck["status"],
  React.ReactNode
> = {
  ok: <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />,
  failed: <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />,
  unverified: (
    <CircleHelp className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
  ),
};

const CHECK_STATUS_LABELS: Record<EnvironmentClusterCheck["status"], string> = {
  ok: "Works",
  failed: "Does not work",
  unverified: "Not verified",
};

function ClusterCheckList({
  server,
  namespace,
  checks,
}: {
  server: string;
  namespace: string;
  checks: EnvironmentClusterCheck[];
}) {
  return (
    <div className="rounded-md border">
      <p className="border-b px-3 py-2 text-xs text-muted-foreground">
        <span className="font-mono">{server}</span>, namespace{" "}
        <span className="font-mono">{namespace}</span>
      </p>
      <ul className="divide-y">
        {checks.map((check) => (
          <li key={check.id} className="flex items-start gap-2 px-3 py-2">
            {CHECK_STATUS_ICONS[check.status]}
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">
                {ENVIRONMENT_CLUSTER_CHECK_LABELS[check.id]}
                <span className="sr-only">
                  : {CHECK_STATUS_LABELS[check.status]}
                </span>
              </p>
              <p className="break-words text-xs text-muted-foreground">
                {check.message}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
