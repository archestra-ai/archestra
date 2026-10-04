"use client";

import { Plug, RefreshCw, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { useAccountConnections } from "@/app/account/_components/use-account-connections";
import { ClaudeCodeAccount } from "@/components/claude-code-account";
import { QueryLoadError } from "@/components/query-load-error";
import { RuntimeCredentialConnectionDialog } from "@/components/runtime-credential-connection-dialog";
import { RuntimeCredentialDisconnectDialog } from "@/components/runtime-credential-disconnect-dialog";
import { RuntimeCredentialRowContent } from "@/components/runtime-credential-row-content";
import { SettingsSection } from "@/components/settings-section";
import { TableRowActions } from "@/components/table-row-actions";
import { useFeature } from "@/lib/config/config.query";
import {
  type RuntimeCredentialDefinition,
  useDeleteRuntimeCredentialConnection,
} from "@/lib/runtime-credentials.query";

/**
 * Credentials your agents use on your behalf — your Claude subscription, your
 * GitHub account, personal secrets an admin defined. Shown only once there is
 * something to connect (or the lookup failed, so the error is not hidden
 * behind a missing section).
 *
 * `/account#connections` is its address: the old `/account/connections` route
 * redirects here, and GitHub sign-in comes back here.
 */
export function ConnectionsSection() {
  const byosEnabled = useFeature("byosEnabled");
  const {
    definitions,
    agents,
    personalDefinitions,
    claudeAgent,
    isError,
    isApplicable,
  } = useAccountConnections();
  const [connecting, setConnecting] =
    useState<RuntimeCredentialDefinition | null>(null);
  const [disconnecting, setDisconnecting] =
    useState<RuntimeCredentialDefinition | null>(null);
  const disconnect = useDeleteRuntimeCredentialConnection();
  const isVisible = isApplicable === true || isError;

  // The section mounts only after its data settles, which is after the
  // browser has already given up looking for the `#connections` anchor, so
  // a deep link (or the return from GitHub sign-in) scrolls here itself.
  useEffect(() => {
    if (isVisible && window.location.hash === `#${CONNECTIONS_SECTION_ID}`) {
      document
        .getElementById(CONNECTIONS_SECTION_ID)
        ?.scrollIntoView({ block: "start" });
    }
  }, [isVisible]);

  if (!isVisible) return null;

  return (
    <SettingsSection
      id={CONNECTIONS_SECTION_ID}
      title="Connections"
      description="Credentials your agents use on your behalf. Values stay private to you."
      className="scroll-mt-6"
    >
      <div>
        {isError ? (
          <QueryLoadError
            title="Couldn't load Agent connections"
            onRetry={() => {
              void definitions.refetch();
              void agents.refetch();
            }}
          />
        ) : (
          <div className="divide-y overflow-hidden rounded-lg border bg-card">
            {claudeAgent && (
              <ClaudeCodeAccount agentId={claudeAgent.id} variant="row" />
            )}
            {personalDefinitions.map((definition) => (
              <div
                key={definition.key}
                className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
              >
                <RuntimeCredentialRowContent
                  definition={definition}
                  configured={definition.personalConfigured}
                />
                <div className="flex items-center gap-2 self-end sm:self-auto">
                  <TableRowActions
                    itemName={definition.name}
                    actions={[
                      {
                        icon: definition.personalConfigured ? (
                          <RefreshCw className="size-4" />
                        ) : (
                          <Plug className="size-4" />
                        ),
                        label: definition.personalConfigured
                          ? "Replace"
                          : "Connect",
                        onClick: () => setConnecting(definition),
                      },
                    ]}
                    dropdownActions={
                      definition.personalConfigured
                        ? [
                            {
                              icon: <Unplug className="size-4" />,
                              label: "Disconnect",
                              onClick: () => setDisconnecting(definition),
                              variant: "destructive",
                            },
                          ]
                        : undefined
                    }
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {connecting && (
        <RuntimeCredentialConnectionDialog
          definition={connecting}
          scope="personal"
          useExternalSecretsManager={byosEnabled}
          onClose={() => setConnecting(null)}
        />
      )}
      <RuntimeCredentialDisconnectDialog
        definition={disconnecting}
        scope="personal"
        open={disconnecting !== null}
        isPending={disconnect.isPending}
        onOpenChange={(open) => {
          if (!open) setDisconnecting(null);
        }}
        onConfirm={() => {
          if (!disconnecting) return;
          disconnect.mutate(
            {
              key: disconnecting.key,
              name: disconnecting.name,
              scope: "personal",
            },
            { onSuccess: () => setDisconnecting(null) },
          );
        }}
      />
    </SettingsSection>
  );
}

const CONNECTIONS_SECTION_ID = "connections";
