"use client";

import { Plug, RefreshCw, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ExecutionCredentialConnectionDialog } from "@/components/execution-credential-connection-dialog";
import { ExecutionCredentialIcon } from "@/components/execution-credential-icon";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFeature } from "@/lib/config/config.query";
import {
  type ExecutionCredentialDefinition,
  useDeleteExecutionCredentialConnection,
  useExecutionCredentials,
} from "@/lib/execution-credentials.query";
import { cn } from "@/lib/utils";

export default function AccountConnectionsPage() {
  const router = useRouter();
  const definitions = useExecutionCredentials();
  const executionEnabled = useFeature("agentBackgroundExecution");
  const byosEnabled = useFeature("byosEnabled");
  const [connecting, setConnecting] =
    useState<ExecutionCredentialDefinition | null>(null);
  const disconnect = useDeleteExecutionCredentialConnection();
  const personalDefinitions = (definitions.data ?? []).filter(
    (definition) => definition.allowPersonal,
  );

  useEffect(() => {
    if (executionEnabled === false) router.replace("/account");
  }, [executionEnabled, router]);

  if (executionEnabled !== true) return null;

  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-medium">Agent connections</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Connect once, then use the credential with any Agent that requests it.
          Values stay private to you.
        </p>
      </div>
      {definitions.isError ? (
        <QueryLoadError
          className="m-5"
          title="Couldn't load Agent connections"
          onRetry={() => definitions.refetch()}
        />
      ) : (
        <div className="divide-y">
          {personalDefinitions.map((definition) => (
            <div
              key={definition.key}
              className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
            >
              <div
                className={cn(
                  "flex min-w-0 flex-1 gap-3",
                  hasCredentialDescription(definition)
                    ? "items-start"
                    : "items-center",
                )}
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
                  <ExecutionCredentialIcon icon={definition.icon} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-sm font-medium">
                      {definition.name}
                    </h3>
                    {definition.personalConfigured && (
                      <span className="flex items-center gap-1 text-xs text-emerald-600">
                        <span className="size-1.5 rounded-full bg-emerald-500" />
                        Connected
                      </span>
                    )}
                  </div>
                  <CredentialRowDescription definition={definition} />
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2 pl-11 sm:pl-0">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      aria-label={
                        definition.personalConfigured
                          ? `Replace ${definition.name}`
                          : `Connect ${definition.name}`
                      }
                      onClick={() => setConnecting(definition)}
                    >
                      {definition.personalConfigured ? (
                        <RefreshCw className="size-4" />
                      ) : (
                        <Plug className="size-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {definition.personalConfigured ? "Replace" : "Connect"}
                  </TooltipContent>
                </Tooltip>
                {definition.personalConfigured && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Disconnect ${definition.name}`}
                        className="text-destructive hover:text-destructive"
                        disabled={disconnect.isPending}
                        onClick={() =>
                          disconnect.mutate(
                            { key: definition.key, scope: "personal" },
                            {
                              onSuccess: () =>
                                toast.success(
                                  `${definition.name} disconnected`,
                                ),
                            },
                          )
                        }
                      >
                        <Unplug className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Disconnect</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          ))}
          {!definitions.isPending && personalDefinitions.length === 0 && (
            <p className="p-5 text-sm text-muted-foreground">
              No personal Agent connections are available.
            </p>
          )}
        </div>
      )}
      {connecting && (
        <ExecutionCredentialConnectionDialog
          definition={connecting}
          scope="personal"
          useExternalSecretsManager={byosEnabled}
          onClose={() => setConnecting(null)}
        />
      )}
    </section>
  );
}

function CredentialRowDescription({
  definition,
}: {
  definition: ExecutionCredentialDefinition;
}) {
  if (definition.key === "claude-code") {
    return (
      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
        A personal subscription token created by the official Claude Code
        client. Run{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] text-foreground">
          claude setup-token
        </code>{" "}
        on your machine to get the value.
      </p>
    );
  }

  if (definition.key === "github") {
    return (
      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
        A GitHub personal access token for repository access. Create one in{" "}
        <a
          href="https://github.com/settings/personal-access-tokens/new"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          GitHub Developer settings
        </a>
        .
      </p>
    );
  }

  if (!definition.description) return null;
  return (
    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
      {definition.description}
    </p>
  );
}

function hasCredentialDescription(
  definition: ExecutionCredentialDefinition,
): boolean {
  return (
    definition.key === "claude-code" ||
    definition.key === "github" ||
    definition.description.trim().length > 0
  );
}
