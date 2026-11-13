"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { siKubernetes } from "simple-icons";
import { AgentRuntimeUnavailableNotice } from "@/components/agent-runtime-unavailable-notice";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { RuntimeTemplateSection } from "@/components/settings/runtime-template-section";
import { SettingsBlock } from "@/components/settings/settings-block";
import { TableRowActions } from "@/components/table-row-actions";
import { useFeature } from "@/lib/config/config.query";
import { cn } from "@/lib/utils/tailwind";

/** Settings → Agents → Runtimes: the runtimes agents run in and their backend. */
export function AgentRuntimeSettings() {
  const runtimeBackend = useFeature("agentRuntimeBackend");
  const runtimeEnabled = useFeature("agentRuntime");
  return (
    <div className="space-y-3">
      {runtimeEnabled === false && <AgentRuntimeUnavailableNotice />}
      <div className={cn("space-y-6", runtimeEnabled !== true && "opacity-50")}>
        <RuntimeTemplateSection disabled={runtimeEnabled !== true} />
        {runtimeBackend && <RuntimeBackendSection />}
      </div>
    </div>
  );
}

function RuntimeBackendSection() {
  return (
    <SettingsBlock
      id="runtime-backend"
      title="Runtime backend"
      description={
        <>
          Runtime backends provide the isolated environment where delegated
          Agent tasks run.{" "}
          <ExternalDocsLink
            href={getDocsUrl(DocsPage.PlatformAgentRuntime)}
            className="whitespace-nowrap"
          >
            Learn more
          </ExternalDocsLink>
        </>
      }
      control={
        <ButtonWithTooltip
          type="button"
          size="sm"
          disabled
          disabledText="Additional runtime backends are coming soon."
        >
          <Plus className="size-4" />
          <span>Add backend</span>
        </ButtonWithTooltip>
      }
    >
      <div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="size-5"
              fill={`#${siKubernetes.hex}`}
            >
              <path d={siKubernetes.path} />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">Kubernetes</h3>
            <p className="text-xs text-muted-foreground">
              Runs each delegated task in an isolated Kubernetes Job
            </p>
          </div>
        </div>
        <div className="self-end sm:self-auto">
          <TableRowActions
            itemName="Kubernetes"
            actions={[
              {
                icon: <Pencil className="size-4" />,
                label: "Edit",
                disabled: true,
                disabledTooltip:
                  "Backend configuration is managed by the deployment today.",
              },
              {
                icon: <Trash2 className="size-4" />,
                label: "Delete",
                variant: "destructive",
                disabled: true,
                disabledTooltip:
                  "Kubernetes is the only supported backend and cannot be removed.",
              },
            ]}
          />
        </div>
      </div>
    </SettingsBlock>
  );
}
