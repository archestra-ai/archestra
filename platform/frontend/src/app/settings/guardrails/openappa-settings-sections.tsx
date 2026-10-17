"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import Link from "next/link";
import { useOpenAppaSetupState } from "@/app/openappa/_parts/use-openappa-setup-state";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { SettingsBlock } from "@/components/settings/settings-block";
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
import { getVisibleDocsUrl } from "@/lib/docs/docs";
import {
  useGuardrailsDeployment,
  useUpdateBreakTheGlassEnabled,
  useUpdateGuardrailsDeployment,
  useUpdateUnsupportedClientAction,
} from "@/lib/guardrails-deployment.query";
import { useAppName } from "@/lib/hooks/use-app-name";

/** Whether tool calls are checked against the policy at all. */
export function OpenAppaEnforcementSetting() {
  const deployment = useGuardrailsDeployment({ poll: true });
  const update = useUpdateGuardrailsDeployment();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const { isFresh } = useOpenAppaSetupState();
  const enabled = Boolean(deployment.data?.enabled);
  return (
    <SettingsBlock
      id="enforcement"
      title="Enforce the policy"
      description={
        enabled ? (
          "Guardrails are on. Every tool call is checked against your policy before it runs."
        ) : isFresh ? (
          // Saving the first policy turns enforcement on; there is nothing to enforce before it.
          <>
            <span>There is no policy yet. </span>
            <Link
              href="/openappa"
              className="text-primary underline underline-offset-2 hover:text-primary/80"
            >
              Create your policy
            </Link>
            <span> to turn this on.</span>
          </>
        ) : (
          "Guardrails are off. Your policy isn't applied, so agents can call any tool."
        )
      }
      control={
        deployment.data ? (
          <Switch
            aria-label="Enforce the policy"
            checked={enabled}
            disabled={
              !canManage ||
              !deployment.data.featureEnabled ||
              isFresh !== false ||
              update.isPending
            }
            onCheckedChange={(checked) => update.mutate(checked)}
          />
        ) : (
          <Skeleton className="h-5 w-9 rounded-full" />
        )
      }
    />
  );
}

/**
 * Whether a yell also turns OpenAPPA off for the session that sends it, so a
 * stuck agent can get unblocked.
 */
export function OpenAppaBreakTheGlassSetting() {
  const deployment = useGuardrailsDeployment({ poll: true });
  const update = useUpdateBreakTheGlassEnabled();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const enabled = Boolean(deployment.data?.breakTheGlassEnabled);
  return (
    <SettingsBlock
      id="break-the-glass"
      title="Break the glass"
      description={
        enabled
          ? "A yell will disable guardrails for the session, unblocking your stuck agents."
          : "A yell only sends a report. Guardrails stay on for the session."
      }
      control={
        deployment.data ? (
          <Switch
            aria-label="Break the glass"
            checked={enabled}
            disabled={
              !canManage || !deployment.data.featureEnabled || update.isPending
            }
            onCheckedChange={(checked) => update.mutate(checked)}
          />
        ) : (
          <Skeleton className="h-5 w-9 rounded-full" />
        )
      }
    />
  );
}

/**
 * What the proxy does with a request the guardrail cannot follow: one from a
 * client with no built-in support that sends no OpenAPPA session headers.
 */
export function OpenAppaClientCoverageSetting() {
  const deployment = useGuardrailsDeployment({ poll: true });
  const update = useUpdateUnsupportedClientAction();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const appName = useAppName();
  return (
    <SettingsBlock
      id="client-coverage"
      title="Other clients"
      description={
        <>
          <span>
            Guardrails follow {appName} chat, Claude Code, Codex, and{" "}
          </span>
          <ClientsDocsLink>more</ClientsDocsLink>
          <span>, plus any client that sends </span>
          <ClientsDocsLink anchor="session-headers">
            OpenAPPA session headers
          </ClientsDocsLink>
          <span>. Requests from any other client are:</span>
        </>
      }
      control={
        deployment.data ? (
          <Select
            value={deployment.data.unsupportedClientAction}
            disabled={
              !canManage || !deployment.data.featureEnabled || update.isPending
            }
            onValueChange={(value) => {
              if (value === "bypass" || value === "block") update.mutate(value);
            }}
          >
            <SelectTrigger
              aria-label="Requests from other clients"
              className="w-full lg:w-48"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem
                value="bypass"
                description="Their model calls work, but guardrails don't check them."
              >
                Allowed
              </SelectItem>
              <SelectItem
                value="block"
                description="Their model calls fail with an error saying how to add support."
              >
                Blocked
              </SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <Skeleton className="h-9 w-48" />
        )
      }
    />
  );
}

/**
 * A docs link inside a sentence. A white-labeled deployment hides public docs
 * links; the words then stay as plain text so the sentence still reads whole.
 */
function ClientsDocsLink({
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
      className="text-primary underline underline-offset-2 hover:text-primary/80"
    >
      {children}
    </ExternalDocsLink>
  );
}
