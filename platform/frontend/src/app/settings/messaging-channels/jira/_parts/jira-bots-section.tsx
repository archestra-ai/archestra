"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Info, Plus } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { AgentSelector } from "@/components/agent-selector";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { RemoteUserSelect } from "@/components/remote-user-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { SecretInput } from "@/components/ui/secret-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAgentOptionsByIds } from "@/lib/agent-options.query";
import {
  useCreateJiraChatOpsBot,
  useDeleteJiraChatOpsBot,
  useUpdateJiraChatOpsBot,
} from "@/lib/chatops/jira.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useServiceAccounts } from "@/lib/service-account.query";
import { JiraProjectBindingForm } from "./jira-project-bindings";

type JiraConfig = archestraApiTypes.GetJiraChatOpsConfigResponses["200"];
type JiraBot = JiraConfig["bots"][number];

export function JiraBotsSection({
  config,
  canEdit,
}: {
  config: JiraConfig;
  canEdit: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const { data: agents = [] } = useAgentOptionsByIds({
    ids: config.bots.map((bot) => bot.agentId),
  });
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>2. Connect Jira bots</CardTitle>
          {canEdit && (
            <Button
              size="sm"
              variant="outline"
              disabled={!config.id}
              onClick={() => setAdding(true)}
            >
              <Plus />
              <span>Connect Jira bot</span>
            </Button>
          )}
        </div>
        <CardDescription>
          Connect an existing Atlassian account to one agent. This verifies the
          account; it does not create a Jira account. Each additional bot needs
          a distinct Jira identity.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {config.bots.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No Jira bots connected. Save the site, then connect the Jira
            identity people will mention.
          </p>
        )}
        {config.bots.map((bot) => (
          <JiraBotCard
            key={bot.id}
            bot={bot}
            agentName={
              agents.find((agent) => agent.id === bot.agentId)?.name ??
              bot.agentId
            }
            canEdit={canEdit}
          />
        ))}
      </CardContent>
      {adding && (
        <ConnectJiraBot
          excludedAgentIds={config.bots.map((bot) => bot.agentId)}
          onClose={() => setAdding(false)}
        />
      )}
    </Card>
  );
}

function JiraBotCard({
  bot,
  agentName,
  canEdit,
}: {
  bot: JiraBot;
  agentName: string;
  canEdit: boolean;
}) {
  const [disconnecting, setDisconnecting] = useState(false);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const update = useUpdateJiraChatOpsBot(bot.id);
  const remove = useDeleteJiraChatOpsBot();
  return (
    <section className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="font-medium">{bot.displayName}</h3>
            <Badge variant="secondary">
              {bot.enabled ? "Enabled" : "Paused"}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {bot.email} → {agentName}
          </p>
          <p className="break-all text-xs text-muted-foreground">
            Verified Jira account ID: {bot.accountId}
          </p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <Switch
              aria-label={`Enable ${bot.displayName}`}
              checked={bot.enabled}
              disabled={update.isPending}
              onCheckedChange={(enabled) => update.mutate({ enabled })}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFallbackOpen(true)}
            >
              Identity fallback
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDisconnecting(true)}
            >
              Disconnect
            </Button>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {bot.fallbackServiceAccountId
          ? "Hidden-email requests use the configured service account and approval reviewer for foreground agents. Runtime agents require a linked human identity."
          : "Hidden-email fallback is off. Foreground agents can use a restricted service account with a human reviewer. Runtime agents require a linked human identity."}
      </p>
      {canEdit && <JiraProjectBindingForm botId={bot.id} />}
      <DeleteConfirmDialog
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title={`Disconnect ${bot.displayName}?`}
        description="This removes the bot's project bindings and stops routing its Jira mentions. The Jira account itself is kept."
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        isPending={remove.isPending}
        onConfirm={() =>
          remove.mutate(bot.id, { onSuccess: () => setDisconnecting(false) })
        }
      />
      {fallbackOpen && (
        <JiraFallbackSettings
          bot={bot}
          onClose={() => setFallbackOpen(false)}
        />
      )}
    </section>
  );
}

function ConnectJiraBot({
  excludedAgentIds,
  onClose,
}: {
  excludedAgentIds: string[];
  onClose: () => void;
}) {
  const appName = useAppName();
  const create = useCreateJiraChatOpsBot();
  const form = useForm({
    defaultValues: {
      agentId: "",
      email: "",
      apiToken: "",
      tokenType: "scoped" as "scoped" | "classic",
    },
  });
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Connect Jira bot"
      description={`Verify an existing Jira identity, then choose the ${appName} agent that answers its mentions.`}
      size="small"
      isDirty={form.formState.isDirty}
    >
      <DialogForm
        onSubmit={form.handleSubmit((values) =>
          create.mutate(
            { ...values, email: values.email.trim() },
            { onSuccess: onClose },
          ),
        )}
      >
        <DialogBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Agent</Label>
            <Controller
              name="agentId"
              control={form.control}
              rules={{ required: "Choose an agent" }}
              render={({ field }) => (
                <AgentSelector
                  mode="single"
                  flat
                  value={field.value}
                  onValueChange={field.onChange}
                  remote={{
                    filters: {
                      agentType: "agent",
                      excludeBuiltIn: true,
                      excludeIds: excludedAgentIds,
                    },
                  }}
                  placeholder="Choose an agent…"
                  className="w-full"
                />
              )}
            />
            {form.formState.errors.agentId && (
              <p className="text-xs text-destructive">
                {form.formState.errors.agentId.message}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="jira-bot-email">Jira account email</Label>
            <Input
              id="jira-bot-email"
              type="email"
              placeholder="bot@example.test"
              aria-invalid={!!form.formState.errors.email}
              {...form.register("email", {
                required: "Enter the Jira account email",
              })}
            />
            {form.formState.errors.email && (
              <p className="text-xs text-destructive">
                {form.formState.errors.email.message}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="jira-bot-token-type">Token type</Label>
            <Controller
              name="tokenType"
              control={form.control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="jira-bot-token-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="scoped">
                      Service account / scoped API token
                    </SelectItem>
                    <SelectItem value="classic">Classic API token</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
            <p className="text-xs text-muted-foreground">
              Atlassian service accounts use scoped API tokens. Choose classic
              only for an existing token created without scopes.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="jira-bot-api-token">Jira API token</Label>
            <SecretInput
              id="jira-bot-api-token"
              aria-invalid={!!form.formState.errors.apiToken}
              {...form.register("apiToken", {
                required: "Enter the Jira API token",
              })}
            />
            {form.formState.errors.apiToken && (
              <p className="text-xs text-destructive">
                {form.formState.errors.apiToken.message}
              </p>
            )}
          </div>
          <InlineNotice variant="info">
            <Info />
            <span className="font-medium">Use the bot's account</span>
            <InlineNoticeText>
              Replies are posted as this Jira identity. The account must be able
              to read the connected projects and add comments. Its display name
              and account ID are verified with Jira.
            </InlineNoticeText>
          </InlineNotice>
        </DialogBody>
        <DialogStickyFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending}>
            <span>
              {create.isPending ? "Verifying…" : "Verify and connect"}
            </span>
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

function JiraFallbackSettings({
  bot,
  onClose,
}: {
  bot: JiraBot;
  onClose: () => void;
}) {
  const appName = useAppName();
  const update = useUpdateJiraChatOpsBot(bot.id);
  const accounts = useServiceAccounts();
  const form = useForm({
    defaultValues: {
      serviceAccountId: bot.fallbackServiceAccountId ?? "",
      reviewerUserId: bot.fallbackReviewerUserId ?? "",
    },
  });
  const serviceAccountId = form.watch("serviceAccountId");
  const reviewerUserId = form.watch("reviewerUserId");
  const paired = !!serviceAccountId === !!reviewerUserId;
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Hidden-email identity fallback"
      description={`When Jira hides a commenter's email, a restricted ${appName} service account can own the run. The Jira requester remains visible in its provenance.`}
      size="small"
      isDirty={form.formState.isDirty}
    >
      <DialogForm
        onSubmit={form.handleSubmit((values) => {
          if (paired)
            update.mutate(
              {
                fallbackServiceAccountId: values.serviceAccountId || null,
                fallbackReviewerUserId: values.reviewerUserId || null,
              },
              { onSuccess: onClose },
            );
        })}
      >
        <DialogBody className="flex flex-col gap-4">
          {accounts.isError ? (
            <QueryLoadError
              title="Could not load service accounts"
              error={accounts.error}
              onRetry={() => void accounts.refetch()}
            />
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="jira-fallback-account">
                {appName} service account
              </Label>
              <Controller
                name="serviceAccountId"
                control={form.control}
                render={({ field }) => (
                  <SearchableSelect
                    id="jira-fallback-account"
                    ariaLabel="Fallback service account"
                    className="w-full"
                    value={field.value || "none"}
                    onValueChange={(value) => {
                      field.onChange(value === "none" ? "" : value);
                      if (value === "none")
                        form.setValue("reviewerUserId", "", {
                          shouldDirty: true,
                        });
                    }}
                    disabled={accounts.isLoading}
                    items={(accounts.data ?? [])
                      .filter((account) => !account.disabled)
                      .map((account) => ({
                        value: account.id,
                        label: account.name,
                      }))}
                    pinnedItems={[
                      { value: "none", label: "Fallback disabled" },
                    ]}
                  />
                )}
              />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label>Human approval reviewer</Label>
            <Controller
              name="reviewerUserId"
              control={form.control}
              render={({ field }) => (
                <RemoteUserSelect
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={!serviceAccountId}
                  ariaLabel="Fallback approval reviewer"
                  placeholder="Choose a reviewer…"
                  className="w-full"
                />
              )}
            />
          </div>
          <InlineNotice variant="info">
            <Info />
            <span className="font-medium">Restricted service identity</span>
            <InlineNoticeText>
              Both identities must have access to this agent. The service
              account's permissions and configured shared connections apply; the
              requester does not borrow another person's credentials. Only the
              selected reviewer can approve gated actions.
            </InlineNoticeText>
          </InlineNotice>
          {!paired && (
            <p className="text-xs text-destructive">
              Select both a service account and a reviewer, or disable fallback.
            </p>
          )}
        </DialogBody>
        <DialogStickyFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!paired || update.isPending || accounts.isError}
          >
            <span>{update.isPending ? "Saving…" : "Save fallback"}</span>
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}
