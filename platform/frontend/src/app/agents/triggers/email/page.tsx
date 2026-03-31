"use client";

import { type archestraApiTypes, DocsPage } from "@shared";
import { AlertTriangle, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import Divider from "@/components/divider";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useInternalAgents } from "@/lib/agent.query";
import { useSession } from "@/lib/auth/auth.query";
import {
  useAgentEmailAddress,
  useDeleteIncomingEmailSubscription,
  useIncomingEmailStatus,
  useRenewIncomingEmailSubscription,
} from "@/lib/chatops/incoming-email.query";
import config from "@/lib/config/config";
import { useConfig, usePublicBaseUrl } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils";
import { CollapsibleSetupSection } from "../_components/collapsible-setup-section";
import { CredentialField } from "../_components/credential-field";
import { ExternalDocsLink } from "../_components/external-docs-link";
import { SetupStep } from "../_components/setup-step";
import { useTriggerStatuses } from "../_components/use-trigger-statuses";
import { AgentEmailSettingsDialog } from "./agent-email-settings-dialog";
import { EmailSetupDialog } from "./email-setup-dialog";
import {
  describeIncomingEmailSecurityMode,
  formatIncomingEmailExpiry,
  formatIncomingEmailSecurityMode,
  getIncomingEmailTimeUntilExpiry,
} from "./email-trigger.utils";

type AgentRecord = archestraApiTypes.GetAllAgentsResponses["200"][number];
type EmailStatusFilter = "all" | "enabled" | "disabled";

export default function EmailPage() {
  const appName = useAppName();
  const docsUrl = getFrontendDocsUrl(DocsPage.PlatformAgentTriggersEmail);
  const publicBaseUrl = usePublicBaseUrl();
  const { data: session } = useSession();
  const { data: configData, isLoading: featuresLoading } = useConfig();
  const { data: status, isLoading: statusLoading } = useIncomingEmailStatus();
  const { data: agents = [], isLoading: agentsLoading } = useInternalAgents({
    enabled: true,
  });
  const renewMutation = useRenewIncomingEmailSubscription();
  const deleteMutation = useDeleteIncomingEmailSubscription();
  const { email: allStepsCompleted } = useTriggerStatuses();

  const [setupOpen, setSetupOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentRecord | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<EmailStatusFilter>("all");

  const isLoading = featuresLoading || statusLoading || agentsLoading;
  const emailInfo = configData?.features.incomingEmail;
  const providerEnabled = !!emailInfo?.enabled;
  const isLocalDev =
    configData?.features.isQuickstart || config.environment === "development";

  const sortedAgents = useMemo(() => {
    return [...agents].sort((left, right) => {
      if (left.incomingEmailEnabled !== right.incomingEmailEnabled) {
        return left.incomingEmailEnabled ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
  }, [agents]);

  const enabledAgentsCount = sortedAgents.filter(
    (agent) => agent.incomingEmailEnabled,
  ).length;
  const disabledAgentsCount = sortedAgents.length - enabledAgentsCount;

  const filteredAgents = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    return sortedAgents.filter((agent) => {
      const matchesStatus =
        statusFilter === "all"
          ? true
          : statusFilter === "enabled"
            ? agent.incomingEmailEnabled
            : !agent.incomingEmailEnabled;
      const matchesSearch =
        !normalizedSearch ||
        agent.name.toLowerCase().includes(normalizedSearch) ||
        agent.authorName?.toLowerCase().includes(normalizedSearch);

      return matchesStatus && matchesSearch;
    });
  }, [search, sortedAgents, statusFilter]);

  const hasActiveFilters = search.trim().length > 0 || statusFilter !== "all";

  return (
    <div className="flex flex-col gap-6">
      <CollapsibleSetupSection
        allStepsCompleted={allStepsCompleted}
        isLoading={isLoading}
        providerLabel="Email"
        docsUrl={docsUrl}
      >
        <SetupStep
          title="Configure an incoming mailbox"
          description={`Connect ${appName} to a shared mailbox and provider credentials`}
          done={providerEnabled}
        >
          {providerEnabled ? (
            <div className="flex items-center flex-wrap gap-4">
              <CredentialField
                label="Provider"
                value={emailInfo?.displayName ?? "Configured"}
              />
              <CredentialField
                label="Email domain"
                value={
                  emailInfo?.emailDomain
                    ? `@${emailInfo.emailDomain}`
                    : undefined
                }
              />
            </div>
          ) : (
            <div className="space-y-2">
              <p>
                Incoming email is configured at deployment time. Add the mailbox
                and provider credentials first, then return here to activate the
                webhook subscription and agent aliases.
              </p>
              <ExternalDocsLink href={docsUrl}>
                Review the email setup guide
              </ExternalDocsLink>
            </div>
          )}
        </SetupStep>

        <SetupStep
          title="Activate the webhook subscription"
          description={`Create or reconfigure the Microsoft Graph subscription that sends new mail events to ${appName}`}
          done={!!status?.isActive}
          ctaLabel={providerEnabled ? "Setup Email" : undefined}
          onAction={providerEnabled ? () => setSetupOpen(true) : undefined}
          doneActionLabel="Reconfigure"
          onDoneAction={providerEnabled ? () => setSetupOpen(true) : undefined}
        >
          {status?.subscription ? (
            <div className="space-y-4">
              <div className="flex items-center flex-wrap gap-4">
                <CredentialField
                  label="Subscription"
                  value={status.subscription.subscriptionId}
                />
                <CredentialField
                  label="Webhook URL"
                  value={status.subscription.webhookUrl}
                />
                <CredentialField
                  label="Expires"
                  value={`${formatIncomingEmailExpiry(status.subscription.expiresAt)} (${getIncomingEmailTimeUntilExpiry(status.subscription.expiresAt)})`}
                />
              </div>

              {!status.isActive && (
                <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
                  <span className="text-xs text-muted-foreground">
                    This subscription has expired. Reconfigure it or renew it to
                    resume email delivery.
                  </span>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <PermissionButton
                  permissions={{ agentTrigger: ["update"] }}
                  variant="outline"
                  onClick={() => renewMutation.mutate()}
                  disabled={renewMutation.isPending}
                >
                  {renewMutation.isPending && (
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Renew subscription
                </PermissionButton>
                <PermissionButton
                  permissions={{ agentTrigger: ["delete"] }}
                  variant="destructive"
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                >
                  {deleteMutation.isPending && (
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete subscription
                </PermissionButton>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p>
                No active subscription exists yet. Open the setup wizard to add
                the public webhook URL that Microsoft Graph should call when new
                mail arrives.
              </p>
              {isLocalDev && (
                <p className="text-xs">
                  Local development needs a public tunnel such as ngrok so the
                  webhook can be reached from Microsoft Graph.
                </p>
              )}
            </div>
          )}
        </SetupStep>
      </CollapsibleSetupSection>

      {providerEnabled && (
        <>
          <Divider />

          <section className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold">Agent Email Access</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Enable email invocation, adjust security rules, and review which
                agents currently have an email alias.
              </p>
            </div>

            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <SearchInput
                placeholder="Search agents..."
                value={search}
                syncQueryParams={false}
                debounceMs={250}
                onSearchChange={setSearch}
                className="relative w-full xl:max-w-md xl:flex-1"
              />

              <div className="flex flex-wrap items-center gap-1 xl:justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Filter: All agents"
                  className={cn(
                    "h-7 text-xs rounded-full gap-1.5",
                    statusFilter === "all" && "bg-primary/10 text-primary",
                  )}
                  onClick={() => setStatusFilter("all")}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
                  All ({sortedAgents.length})
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Filter: Enabled agents"
                  className={cn(
                    "h-7 text-xs rounded-full gap-1.5",
                    statusFilter === "enabled"
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "text-muted-foreground",
                  )}
                  onClick={() => setStatusFilter("enabled")}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  Enabled ({enabledAgentsCount})
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Filter: Disabled agents"
                  className={cn(
                    "h-7 text-xs rounded-full gap-1.5",
                    statusFilter === "disabled"
                      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      : "text-muted-foreground",
                  )}
                  onClick={() => setStatusFilter("disabled")}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                  Disabled ({disabledAgentsCount})
                </Button>
              </div>
            </div>

            <div className="overflow-hidden rounded-md border">
              <Table>
                <TableHeader className="bg-muted border-b-2 border-border">
                  <TableRow>
                    <TableHead className="w-[26%]">Agent</TableHead>
                    <TableHead className="w-[16%]">Status</TableHead>
                    <TableHead className="w-[24%]">Security</TableHead>
                    <TableHead className="w-[24%]">Email alias</TableHead>
                    <TableHead className="w-[10%] text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAgents.length > 0 ? (
                    filteredAgents.map((agent) => (
                      <EmailAgentRow
                        key={agent.id}
                        agent={agent}
                        currentUserId={session?.user?.id}
                        onEdit={() => setEditingAgent(agent)}
                        providerEnabled={providerEnabled}
                      />
                    ))
                  ) : (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="h-40 text-center text-sm text-muted-foreground"
                      >
                        <div className="flex flex-col items-center justify-center gap-4">
                          <p>
                            {hasActiveFilters
                              ? "No agents match your current filters."
                              : "No internal agents are available yet."}
                          </p>
                          {hasActiveFilters && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setSearch("");
                                setStatusFilter("all");
                              }}
                            >
                              Clear filters
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </section>
        </>
      )}

      <EmailSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        emailDomain={emailInfo?.emailDomain}
        providerLabel={emailInfo?.displayName}
        publicBaseUrl={publicBaseUrl}
      />

      <AgentEmailSettingsDialog
        agent={editingAgent}
        open={!!editingAgent}
        onOpenChange={(open) => {
          if (!open) {
            setEditingAgent(null);
          }
        }}
        providerEnabled={providerEnabled}
      />
    </div>
  );
}

function EmailAgentRow({
  agent,
  currentUserId,
  onEdit,
  providerEnabled,
}: {
  agent: AgentRecord;
  currentUserId: string | undefined;
  onEdit: () => void;
  providerEnabled: boolean;
}) {
  const appName = useAppName();
  const { data: emailAddress } = useAgentEmailAddress(
    providerEnabled && agent.incomingEmailEnabled ? agent.id : null,
  );

  return (
    <TableRow>
      <TableCell>
        <div className="space-y-2">
          <div className="font-medium">{agent.name}</div>
          <ResourceVisibilityBadge
            scope={agent.scope}
            teams={agent.teams}
            authorId={agent.authorId}
            authorName={agent.authorName}
            currentUserId={currentUserId}
          />
        </div>
      </TableCell>
      <TableCell>
        {agent.incomingEmailEnabled ? (
          <Badge
            variant="secondary"
            className="bg-green-500/10 text-green-700 dark:text-green-400"
          >
            Enabled
          </Badge>
        ) : (
          <Badge variant="secondary">Disabled</Badge>
        )}
      </TableCell>
      <TableCell>
        {agent.incomingEmailEnabled ? (
          <div className="space-y-1">
            <div className="font-medium">
              {formatIncomingEmailSecurityMode(agent.incomingEmailSecurityMode)}
            </div>
            <p className="text-xs text-muted-foreground">
              {describeIncomingEmailSecurityMode(
                agent.incomingEmailSecurityMode,
                agent.incomingEmailAllowedDomain,
                appName,
              )}
            </p>
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">
            Not enabled for this agent
          </span>
        )}
      </TableCell>
      <TableCell>
        {agent.incomingEmailEnabled ? (
          emailAddress?.emailAddress ? (
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all text-xs">
                {emailAddress.emailAddress}
              </code>
              <CopyButton text={emailAddress.emailAddress} />
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">
              Loading alias...
            </span>
          )
        ) : (
          <span className="text-sm text-muted-foreground">
            Save settings to generate an alias
          </span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <PermissionButton
          permissions={{ agent: ["update"] }}
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={onEdit}
          title={
            agent.incomingEmailEnabled
              ? "Edit email settings"
              : "Configure email"
          }
          aria-label={
            agent.incomingEmailEnabled
              ? "Edit email settings"
              : "Configure email"
          }
        >
          <Settings2 className="h-4 w-4" />
          <span className="sr-only">
            {agent.incomingEmailEnabled
              ? "Edit email settings"
              : "Configure email"}
          </span>
        </PermissionButton>
      </TableCell>
    </TableRow>
  );
}
