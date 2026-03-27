"use client";

import type { archestraApiTypes } from "@shared";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Mail,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import Divider from "@/components/divider";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { CollapsibleSetupSection } from "../_components/collapsible-setup-section";
import { CredentialField } from "../_components/credential-field";
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

export default function EmailPage() {
  const appName = useAppName();
  const docsUrl = getFrontendDocsUrl("platform-agent-triggers-email");
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
  const publicAgentsCount = sortedAgents.filter(
    (agent) =>
      agent.incomingEmailEnabled &&
      agent.incomingEmailSecurityMode === "public",
  ).length;
  const restrictedAgentsCount = enabledAgentsCount - publicAgentsCount;

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
              {docsUrl && (
                <Link
                  href={docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  Review the email setup guide
                  <ExternalLink className="h-3 w-3" />
                </Link>
              )}
            </div>
          )}
        </SetupStep>

        <SetupStep
          title="Activate the webhook subscription"
          description="Create or reconfigure the Microsoft Graph subscription that sends new mail events to Archestra"
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
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Agent Email Access</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Enable email invocation, adjust security rules, and review
                  which agents currently have an email alias.
                </p>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">
                    Email-enabled agents
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex items-center gap-3">
                  <Mail className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <div className="text-2xl font-semibold">
                      {enabledAgentsCount}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Agents currently invocable by email
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">
                    Private or internal
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex items-center gap-3">
                  <CheckCircle2 className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <div className="text-2xl font-semibold">
                      {restrictedAgentsCount}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Restricted to known users or approved domains
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">
                    Public agents
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex items-center gap-3">
                  <Badge
                    variant="secondary"
                    className="bg-amber-500/10 text-amber-700"
                  >
                    Public
                  </Badge>
                  <div>
                    <div className="text-2xl font-semibold">
                      {publicAgentsCount}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Agents accepting email from any sender
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card className="overflow-hidden">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Agent aliases</CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[26%]">Agent</TableHead>
                      <TableHead className="w-[16%]">Status</TableHead>
                      <TableHead className="w-[24%]">Security</TableHead>
                      <TableHead className="w-[24%]">Email alias</TableHead>
                      <TableHead className="w-[10%] text-right">
                        Action
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedAgents.length > 0 ? (
                      sortedAgents.map((agent) => (
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
                          className="py-10 text-center text-sm text-muted-foreground"
                        >
                          No internal agents are available yet.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
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
          size="sm"
          variant="outline"
          onClick={onEdit}
        >
          <Settings2 className="mr-2 h-4 w-4" />
          {agent.incomingEmailEnabled ? "Edit" : "Configure"}
        </PermissionButton>
      </TableCell>
    </TableRow>
  );
}
