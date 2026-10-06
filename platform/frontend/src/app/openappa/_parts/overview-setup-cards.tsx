"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import {
  ArrowRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  Github,
  MessageCircle,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { OpenAppaAlertIcon } from "@/components/openappa-icon";
import { OpenAppaMascot } from "@/components/openappa-mascot";
import { SettingsBlock } from "@/components/settings/settings-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { getVisibleDocsUrl } from "@/lib/docs/docs";
import {
  useGuardrailsDeployment,
  useUpdateGuardrailsDeployment,
  useUpdateUnsupportedClientAction,
} from "@/lib/guardrails-deployment.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import { useOpenAppaYellsSummary } from "@/lib/openappa-yells.query";
import { cn } from "@/lib/utils/tailwind";
import {
  OpenAppaCreateRepositoryDialog,
  OpenAppaSourceForm,
} from "./appa-github-sync-panel";
import { GithubManagedPolicyNotice } from "./github-managed-policy-notice";
import { OpenAppaChatButton } from "./openappa-chat-button";
import { useOpenAppaSetupState } from "./use-openappa-setup-state";

/**
 * Where OpenAPPA setup stands. A fresh organization sees only the first step,
 * saving a policy in the policy chat (which turns enforcement on). After that,
 * three compact cards report enforcement, GitHub sync, and unresolved yells.
 * The first unfinished one is highlighted as the next step.
 */
export function OverviewSetupCards() {
  const { enabled, isFresh } = useOpenAppaSetupState();
  const sync = useAppaGithubSync();
  const { data: canReadYells } = useHasPermissions({
    openappaDiagnostics: ["read"],
  });
  const { data: canReadSettings } = useHasPermissions({
    organizationSettings: ["read"],
  });
  if (isFresh === undefined) return null;
  if (isFresh) return <PolicyStep />;
  const source = sync.data?.source;
  const synced = Boolean(source?.interval && !source.lastSyncError);
  const next = !enabled
    ? "enforcement"
    : sync.data?.enabled && !synced
      ? "github"
      : null;
  return (
    <div className="space-y-4">
      {source?.lastSyncError && <GithubManagedPolicyNotice />}
      <div
        className={cn(
          "grid gap-4",
          canReadYells ? "xl:grid-cols-3" : "lg:grid-cols-2",
        )}
      >
        {canReadSettings && <EnforcementCard next={next === "enforcement"} />}
        {canReadSettings && <GithubSyncCard next={next === "github"} />}
        {canReadYells && <YellsCard />}
      </div>
    </div>
  );
}

/**
 * The whole page for an organization that has not saved a policy yet. There is
 * one thing to do here, so the page is that one thing: the mascot, what the
 * guardrail is for, and the button.
 */
function PolicyStep() {
  const { data: canEdit } = useHasPermissions({ openappaPolicy: ["update"] });
  return (
    <section className="mx-auto flex max-w-xl flex-col items-center px-2 py-10 text-center sm:py-16">
      {/* A flat disc rather than a blurred glow: the mark is pixel art with
          hard edges, and a soft halo behind it reads as a smudge on the page
          rather than as a deliberate ground. */}
      <span className="flex size-40 items-center justify-center rounded-full bg-muted sm:size-52">
        <OpenAppaMascot className="size-24 sm:size-32" />
      </span>
      <h2 className="mt-8 text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
        Turn on the guardrail
      </h2>
      <p className="mt-3 leading-relaxed text-pretty text-muted-foreground">
        OpenAPPA is a frontier deterministic guardrail. It tracks where data
        came from and who may see it, rather than asking a second model to
        judge, which makes it 100% resistant to data exfiltration from prompt
        injection or model hallucination.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
        {canEdit ? (
          <OpenAppaChatButton promptKey="setUpPolicy">
            <MessageCircle />
            <span>Create my policy</span>
          </OpenAppaChatButton>
        ) : (
          <p className="text-sm text-muted-foreground">
            Ask an administrator to turn on the guardrail.
          </p>
        )}
        <ExternalDocsLink
          href={openAppaUrl("/how-it-works")}
          className="text-sm"
        >
          How OpenAPPA works
        </ExternalDocsLink>
      </div>
    </section>
  );
}

function EnforcementCard({ next }: { next: boolean }) {
  const { enabled } = useOpenAppaSetupState();
  const deployment = useGuardrailsDeployment();
  const update = useUpdateGuardrailsDeployment();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const appName = useAppName();
  return (
    <StatusCard
      next={next}
      icon={<ShieldCheck />}
      title="Enforcement"
      status={enabled ? <Status done>On</Status> : <Status>Off</Status>}
      description={
        <span>
          <span>
            {enabled
              ? `${appName} checks tool calls against your policy before they run.`
              : "Tool calls run without policy checks. Turn enforcement on to apply your policy."}
          </span>
          {!canManage && (
            <span> Only administrators can change enforcement settings.</span>
          )}
        </span>
      }
      action={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Switch
              id="openappa-overview-enforcement"
              checked={Boolean(enabled)}
              disabled={
                !canManage ||
                !deployment.data?.featureEnabled ||
                update.isPending
              }
              onCheckedChange={(checked) => update.mutate(checked)}
            />
            <Label
              htmlFor="openappa-overview-enforcement"
              className="text-sm cursor-pointer"
            >
              Enforce the policy
            </Label>
          </div>
          <OpenAppaChatButton
            size="sm"
            variant="outline"
            promptKey="explainPolicy"
          >
            <MessageCircle />
            <span>Ask about the policy</span>
          </OpenAppaChatButton>
        </div>
      }
    />
  );
}

function GithubSyncCard({ next }: { next: boolean }) {
  const sync = useAppaGithubSync();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const appName = useAppName();
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const source = sync.data?.source ?? null;
  const connected = Boolean(source?.interval);
  const failed = source?.lastSyncError;
  return (
    <>
      <StatusCard
        next={next}
        icon={<Github />}
        title="GitHub sync"
        status={
          !sync.data ? null : failed ? (
            <Status failed>Sync failed</Status>
          ) : next ? (
            <Badge>Step 2 of 2</Badge>
          ) : connected ? (
            <Status done>Connected</Status>
          ) : !sync.data.enabled ? (
            <Status>Not available</Status>
          ) : (
            <Status>Not connected</Status>
          )
        }
        description={
          connected && source?.repo ? (
            <span>
              {appName} pulls the policy from{" "}
              <span className="font-mono text-foreground">{source.repo}</span>.
              Every change is a reviewed pull request.
            </span>
          ) : sync.data && !sync.data.enabled ? (
            "GitHub sync is turned off on this server."
          ) : (
            "Keep your guardrail policy in a repository, so every change is a reviewed pull request."
          )
        }
        learnMore={{
          href: openAppaUrl("/validation"),
          label: "CI checks",
        }}
        action={
          !sync.data?.enabled ? null : !canManage ? (
            connected ? null : (
              <p className="text-sm text-muted-foreground">
                Ask an administrator to connect a repository.
              </p>
            )
          ) : connected || failed ? (
            <Button size="sm" variant="outline" asChild>
              <Link href="/settings/openappa">
                <span>Sync settings</span>
                <ArrowRight />
              </Link>
            </Button>
          ) : (
            <Button
              size="sm"
              variant={next ? "default" : "outline"}
              onClick={() => setCreating(true)}
            >
              <Github />
              <span>Create repository</span>
            </Button>
          )
        }
      />
      {editing && (
        <OpenAppaSourceForm source={source} onOpenChange={setEditing} />
      )}
      {creating && (
        <OpenAppaCreateRepositoryDialog
          onOpenChange={setCreating}
          onConnectExisting={() => {
            setCreating(false);
            setEditing(true);
          }}
        />
      )}
    </>
  );
}

function YellsCard() {
  const summary = useOpenAppaYellsSummary();
  return (
    <StatusCard
      icon={
        <span className="w-6">
          <OpenAppaAlertIcon animated className="w-full overflow-visible" />
        </span>
      }
      title="Yells"
      description="Reports of confusing blocks or remedies. Investigate them with the configuration agent."
      action={
        <Button size="sm" variant="outline" asChild>
          <Link href="/openappa/yells">
            Review yells <ArrowRight />
          </Link>
        </Button>
      }
    >
      {summary.isError ? (
        <Button variant="ghost" size="sm" onClick={() => summary.refetch()}>
          Could not load yells. Retry
        </Button>
      ) : (
        <p className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums">
            {summary.data?.unresolved ?? "—"}
          </span>
          <span className="text-sm text-muted-foreground">unresolved</span>
        </p>
      )}
    </StatusCard>
  );
}

/**
 * What the proxy does with a request that Guardrails cannot follow: one from
 * a client with no built-in support that sends no OpenAPPA session headers.
 * The inside is a settings block, so it reads like the settings pages; the
 * card around it matches the other tiles on this page.
 */
export function UnrecognizedClientsCard() {
  const query = useGuardrailsDeployment();
  const update = useUpdateUnsupportedClientAction();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const appName = useAppName();
  if (!query.data || query.isError) return null;
  return (
    <Card className="py-5">
      <CardContent className="px-5">
        <SettingsBlock
          title="Client coverage"
          description={
            <>
              <span>
                Guardrails work with natively supported clients like {appName}{" "}
                chat, Claude Code, Codex, and{" "}
              </span>
              <GuardrailsDocsLink>more</GuardrailsDocsLink>
              <span>, and with any client that correctly sends </span>
              <GuardrailsDocsLink anchor="session-headers">
                OpenAPPA session headers
              </GuardrailsDocsLink>
              <span>.</span>
            </>
          }
        >
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
            <Label
              htmlFor="openappa-unrecognized-clients"
              className="text-sm text-muted-foreground"
            >
              Requests from clients without native support or recognized
              OpenAPPA session headers should be:
            </Label>
            <Select
              value={query.data.unsupportedClientAction}
              disabled={
                !canManage || !query.data.featureEnabled || update.isPending
              }
              onValueChange={(value) => {
                if (value === "bypass" || value === "block")
                  update.mutate(value);
              }}
            >
              <SelectTrigger
                id="openappa-unrecognized-clients"
                className="w-48"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem
                  value="bypass"
                  description="Requests run without checks."
                >
                  Allowed
                </SelectItem>
                <SelectItem
                  value="block"
                  description="The proxy rejects requests."
                >
                  Blocked
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {!canManage && (
            <p className="mt-2 text-xs text-muted-foreground">
              Only administrators can change this setting.
            </p>
          )}
        </SettingsBlock>
      </CardContent>
    </Card>
  );
}

/**
 * A docs link that is part of a sentence. A white-labeled deployment hides
 * links to the public docs; the words then stay as plain text, so the
 * sentence still reads whole.
 */
function GuardrailsDocsLink({
  anchor,
  children,
}: {
  anchor?: string;
  children: string;
}) {
  const href = getVisibleDocsUrl(
    getDocsUrl(DocsPage.PlatformAiToolGuardrailsClients, anchor),
  );
  if (!href) return <span>{children}</span>;
  return (
    <ExternalDocsLink
      href={href}
      showIcon={false}
      className="text-primary underline-offset-2 hover:underline"
    >
      {children}
    </ExternalDocsLink>
  );
}

function StatusCard({
  next,
  icon,
  title,
  status,
  description,
  children,
  learnMore,
  action,
}: {
  next?: boolean;
  icon: ReactNode;
  title: string;
  status?: ReactNode;
  description: ReactNode;
  children?: ReactNode;
  learnMore?: { href: string; label: string };
  action: ReactNode;
}) {
  return (
    <Card
      className={cn("gap-3 py-4", next && "border-primary")}
      data-next-step={next || undefined}
    >
      <CardHeader className="flex items-center gap-3 px-4">
        <CardIcon>{icon}</CardIcon>
        <CardTitle className="flex-1 text-sm whitespace-nowrap">
          {title}
        </CardTitle>
        {status}
      </CardHeader>
      <CardContent className="flex-1 px-4 space-y-3">
        <CardDescription className="leading-relaxed">
          {description}
        </CardDescription>
        {children}
      </CardContent>
      {(action || learnMore) && (
        <CardFooter className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4">
          {action}
          {learnMore && (
            <ExternalDocsLink
              href={learnMore.href}
              className="shrink-0 text-xs text-muted-foreground"
            >
              {learnMore.label}
            </ExternalDocsLink>
          )}
        </CardFooter>
      )}
    </Card>
  );
}

function CardIcon({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary [&>svg]:size-4">
      {children}
    </span>
  );
}

function Status({
  done,
  failed,
  children,
}: {
  done?: boolean;
  failed?: boolean;
  children: string;
}) {
  return (
    <Badge variant={failed ? "destructive" : "outline"}>
      {failed ? (
        <CircleX />
      ) : done ? (
        <CircleCheck className="text-emerald-600 dark:text-emerald-400" />
      ) : (
        <CircleDashed className="text-muted-foreground" />
      )}
      <span>{children}</span>
    </Badge>
  );
}

/** A page of the OpenAPPA site, where the concepts behind a card are explained. */
export function openAppaUrl(path: string): string {
  return `https://www.openappa.com${path}`;
}
