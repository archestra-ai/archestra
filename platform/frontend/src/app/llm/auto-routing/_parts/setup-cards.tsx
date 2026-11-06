"use client";

import {
  CircleCheck,
  CircleDashed,
  KeyRound,
  Layers,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AutoRoutingSettings } from "@/lib/auto-routing.query";
import { useLlmModels } from "@/lib/llm-models.query";
import { AddJevKeyLink } from "./add-jev-key";
import { ConfigureAutoRoutingButton } from "./configure-button";
import { TIER_LABELS, TIER_NAMES } from "./tiers";

/** Whether auto routing can route: a Jev key scores sessions, the three tiers are set, and it is on. */
export function isAutoRoutingSetUp(settings: AutoRoutingSettings): boolean {
  return (
    settings.status.scorer === "ready" &&
    TIER_NAMES.every((tier) => settings.tiers[tier] !== null) &&
    settings.enabled
  );
}

/** The three things auto routing needs, each with where it stands. */
export function SetupCards({ settings }: { settings: AutoRoutingSettings }) {
  return (
    <section aria-labelledby="auto-routing-setup" className="space-y-3">
      <div className="space-y-1">
        <h2 id="auto-routing-setup" className="text-base font-semibold">
          Set up auto routing
        </h2>
        <p className="text-sm text-muted-foreground">
          Auto picks a fast, normal or smart model for each session, within a
          daily budget.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <JevCard settings={settings} />
        <ModelsCard settings={settings} />
        <UseAutoCard settings={settings} />
      </div>
    </section>
  );
}

/** Where Auto is picked, for the routing-at-a-glance view. */
export function UsageLine({ settings }: { settings: AutoRoutingSettings }) {
  return (
    <p className="text-sm text-muted-foreground">
      <span>{usageText(settings.usage)}</span>{" "}
      <Link href="/settings/agents" className="text-primary hover:underline">
        Change the organization default
      </Link>
    </p>
  );
}

// =============================================================================
// Internal
// =============================================================================

function JevCard({ settings }: { settings: AutoRoutingSettings }) {
  const key = settings.status.scorerApiKey;
  return (
    <StatusCard
      step={1}
      icon={<KeyRound />}
      title="Connect Jev"
      status={key ? <Status done>Connected</Status> : <Status>Needed</Status>}
      description={
        key ? (
          <span>
            Sessions are scored with{" "}
            <span className="font-medium text-foreground">{key.name}</span>.
          </span>
        ) : (
          <span>
            Jev reads each session to judge how hard it is. It needs a Jev key
            shared with the whole organization.
          </span>
        )
      }
      action={
        key ? (
          <Link
            href="/llm/model-providers"
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            Manage in Model Providers
          </Link>
        ) : (
          <AddJevKeyLink />
        )
      }
    />
  );
}

function ModelsCard({ settings }: { settings: AutoRoutingSettings }) {
  const { data: models = [] } = useLlmModels();
  const set = TIER_NAMES.filter((tier) => settings.tiers[tier] !== null);
  const ready = set.length === TIER_NAMES.length;
  return (
    <StatusCard
      step={2}
      icon={<Layers />}
      title="Choose models"
      status={
        ready && settings.enabled ? (
          <Status done>On</Status>
        ) : ready ? (
          <Status>Off</Status>
        ) : (
          <Status>{`${set.length} of 3 set`}</Status>
        )
      }
      description={
        <span>
          A model and organization key for each tier, a daily budget, and the
          switch that turns Auto on.
        </span>
      }
      action={
        <ConfigureAutoRoutingButton variant={ready ? "outline" : "default"}>
          {ready ? "Configure" : "Choose models"}
        </ConfigureAutoRoutingButton>
      }
    >
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        {TIER_NAMES.map((tier) => {
          const model = settings.tiers[tier];
          return (
            <div key={tier} className="contents">
              <dt className="text-muted-foreground">{TIER_LABELS[tier]}</dt>
              <dd className="truncate">
                {model ? (
                  <span>
                    {models.find((m) => m.dbId === model.id)?.displayName ??
                      model.modelId}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Not set</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </StatusCard>
  );
}

function UseAutoCard({ settings }: { settings: AutoRoutingSettings }) {
  const { agentCount, organizationDefault } = settings.usage;
  return (
    <StatusCard
      step={3}
      icon={<Sparkles />}
      title="Use Auto"
      status={
        agentCount > 0 || organizationDefault ? (
          <Status done>In use</Status>
        ) : (
          <Status>Not used yet</Status>
        )
      }
      description={
        <span>
          Pick Auto as an agent&apos;s model, in a chat&apos;s model menu, or as
          the organization default. API clients request the model{" "}
          <code>auto</code>.
        </span>
      }
      action={
        <Link
          href="/settings/agents"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          Set the organization default
        </Link>
      }
    >
      <p className="text-sm">
        <span>{usageText(settings.usage)}</span>
      </p>
    </StatusCard>
  );
}

/** What runs on Auto, in a sentence. */
function usageText(usage: AutoRoutingSettings["usage"]): string {
  const agents =
    usage.agentCount === 1 ? "1 agent" : `${usage.agentCount} agents`;
  if (usage.organizationDefault) {
    const base =
      "Auto is the organization default: every chat and agent without a model of its own runs on it.";
    return usage.agentCount > 0
      ? `${base} ${agents} also ${usage.agentCount === 1 ? "has" : "have"} Auto set directly.`
      : base;
  }
  return usage.agentCount > 0
    ? `${agents} ${usage.agentCount === 1 ? "runs" : "run"} on Auto. The organization default is a fixed model.`
    : "Nothing runs on Auto yet. Pick it for an agent or a chat, or make it the organization default.";
}

function StatusCard({
  step,
  icon,
  title,
  status,
  description,
  children,
  action,
}: {
  step: number;
  icon: ReactNode;
  title: string;
  status: ReactNode;
  description: ReactNode;
  children?: ReactNode;
  action: ReactNode;
}) {
  return (
    <Card className="gap-3 py-4" data-testid={`auto-routing-setup-${step}`}>
      <CardHeader className="flex items-center gap-3 px-4">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary [&>svg]:size-4">
          {icon}
        </span>
        <CardTitle className="flex-1 text-sm whitespace-nowrap">
          <span className="text-muted-foreground">{step}. </span>
          {title}
        </CardTitle>
        {status}
      </CardHeader>
      <CardContent className="flex-1 space-y-3 px-4">
        <CardDescription className="leading-relaxed">
          {description}
        </CardDescription>
        {children}
      </CardContent>
      <CardFooter className="px-4">{action}</CardFooter>
    </Card>
  );
}

function Status({ done, children }: { done?: boolean; children: string }) {
  return (
    <Badge variant="outline">
      {done ? (
        <CircleCheck className="text-emerald-600 dark:text-emerald-400" />
      ) : (
        <CircleDashed className="text-muted-foreground" />
      )}
      <span>{children}</span>
    </Badge>
  );
}
