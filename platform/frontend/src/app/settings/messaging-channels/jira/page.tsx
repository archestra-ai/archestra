"use client";

import { type archestraApiTypes, DocsPage } from "@archestra/shared";
import { Info } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SecretInput } from "@/components/ui/secret-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useJiraChatOpsConfig,
  useUpdateJiraChatOpsConfig,
} from "@/lib/chatops/jira.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { JiraBotsSection } from "./jira-bots-section";
import { JiraProjectBindings } from "./jira-project-bindings";

type JiraConfig = archestraApiTypes.GetJiraChatOpsConfigResponses["200"];

export default function JiraPage() {
  const appName = useAppName();
  const config = useJiraChatOpsConfig();
  const { data: canEdit = false } = useHasPermissions({
    organizationSettings: ["update"],
  });

  if (config.isLoading) return <Skeleton className="h-56 w-full" />;
  if (config.isError || !config.data) {
    return (
      <QueryLoadError
        title="Could not load Jira configuration"
        error={config.error}
        onRetry={() => void config.refetch()}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Mention a connected Jira bot in an issue comment to talk to its{" "}
        {appName} agent. Each project has its own instructions, and each issue
        is a conversation.
      </p>
      <ExternalDocsLink
        href={getFrontendDocsUrl(DocsPage.PlatformJira)}
        className="text-sm"
      >
        Jira setup guide
      </ExternalDocsLink>
      <JiraSiteSetup
        key={config.data.id ?? "new"}
        config={config.data}
        canEdit={canEdit}
      />
      <JiraBotsSection config={config.data} canEdit={canEdit} />
      <JiraProjectBindings bots={config.data.bots} canEdit={canEdit} />
    </div>
  );
}

function JiraSiteSetup({
  config,
  canEdit,
}: {
  config: JiraConfig;
  canEdit: boolean;
}) {
  const update = useUpdateJiraChatOpsConfig();
  const form = useForm({
    defaultValues: {
      siteUrl: config.siteUrl,
      ingressMode: config.ingressMode,
      enabled: config.enabled,
      webhookSecret: "",
    },
  });
  const ingressMode = form.watch("ingressMode");

  return (
    <Card>
      <CardHeader>
        <CardTitle>1. Connect your Jira Cloud site</CardTitle>
        <CardDescription>
          Jira Cloud only. Choose polling for private installations, or receive
          webhooks at a public HTTPS address. Jira Server and Data Center are
          not supported yet.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={form.handleSubmit((values) =>
            update.mutate(
              {
                enabled: values.enabled,
                siteUrl: values.siteUrl.trim(),
                ingressMode: values.ingressMode,
                ...(values.ingressMode !== "poll" &&
                  values.webhookSecret.trim() && {
                    webhookSecret: values.webhookSecret.trim(),
                  }),
              },
              {
                onSuccess: () => {
                  form.reset({ ...values, webhookSecret: "" });
                  update.reset();
                },
              },
            ),
          )}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="jira-site-url">Jira site URL</Label>
            <Input
              id="jira-site-url"
              placeholder="https://example.atlassian.net"
              disabled={!canEdit || config.bots.length > 0}
              aria-invalid={!!form.formState.errors.siteUrl}
              {...form.register("siteUrl", {
                required: "Enter your Jira Cloud site URL",
                validate: (value) =>
                  /^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net(?:\/jira\/?)?\/?$/i.test(
                    value.trim(),
                  ) ||
                  "Use an HTTPS tenant.atlassian.net URL without a query or fragment",
              })}
            />
            {form.formState.errors.siteUrl && (
              <p className="text-xs text-destructive">
                {form.formState.errors.siteUrl.message}
              </p>
            )}
            {config.bots.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Disconnect the site's bots before changing the site URL.
              </p>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="jira-ingress-mode">Event delivery</Label>
              <Controller
                name="ingressMode"
                control={form.control}
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={!canEdit}
                  >
                    <SelectTrigger id="jira-ingress-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="poll">
                        Poll Jira every minute
                      </SelectItem>
                      <SelectItem value="hmac">Signed Jira webhook</SelectItem>
                      <SelectItem value="automation">
                        Jira Automation web request
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            {ingressMode !== "poll" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="jira-webhook-secret">
                  {ingressMode === "hmac"
                    ? "Webhook signing secret"
                    : "Automation header secret"}
                </Label>
                <SecretInput
                  id="jira-webhook-secret"
                  disabled={!canEdit}
                  placeholder={
                    config.hasWebhookSecret
                      ? "Saved — leave blank to keep"
                      : "Enter a shared secret"
                  }
                  {...form.register("webhookSecret", {
                    validate: (value) =>
                      form.getValues("ingressMode") === "poll" ||
                      (!value.trim() && config.hasWebhookSecret) ||
                      value.trim().length >= 16 ||
                      "Use a secret with at least 16 characters",
                  })}
                />
                {form.formState.errors.webhookSecret && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.webhookSecret.message}
                  </p>
                )}
              </div>
            )}
          </div>
          {ingressMode === "poll" ? (
            <p className="text-xs text-muted-foreground">
              Checks connected projects every minute. No public callback or
              webhook secret is needed. Only comments created or edited after
              polling is enabled start conversations.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {ingressMode === "hmac"
                  ? "Configure Jira to sign comment events with this secret."
                  : "Set the Automation request's x-archestra-jira-secret header to this value."}{" "}
                This secret authenticates incoming events; it is separate from
                each bot's Jira API token.
              </p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="jira-webhook-url">Webhook URL</Label>
                <Input
                  id="jira-webhook-url"
                  readOnly
                  value={config.webhookUrl ?? ""}
                  placeholder="Save the site to get its webhook URL"
                />
                <p className="text-xs text-muted-foreground">
                  Jira Cloud must be able to reach this HTTPS address. Configure
                  comment-created and comment-updated events for the projects
                  you connect below.
                </p>
              </div>
            </>
          )}
          <div className="flex items-center gap-2">
            <Controller
              name="enabled"
              control={form.control}
              render={({ field }) => (
                <Switch
                  id="jira-enabled"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={!canEdit}
                />
              )}
            />
            <Label htmlFor="jira-enabled">Receive Jira events</Label>
          </div>
          <InlineNotice variant="info">
            <Info />
            <span className="font-medium">Bot mentions only</span>
            <InlineNoticeText>
              Use the bot's actual Jira mention. Its own comments do not start
              another reply. Comment “mute” or add the archestra-mute label to
              stop replies on an issue.
            </InlineNoticeText>
          </InlineNotice>
          <InlineNotice>
            <Info />
            <span className="font-medium">Project-wide conversations</span>
            <InlineNoticeText>
              Restricted issues and comments are not supported. Connect only
              projects whose issues and comments are visible to every person
              allowed to use the agent.
            </InlineNoticeText>
          </InlineNotice>
          {canEdit && (
            <Button
              type="submit"
              size="sm"
              className="self-start"
              disabled={update.isPending}
            >
              <span>{update.isPending ? "Saving…" : "Save Jira site"}</span>
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
