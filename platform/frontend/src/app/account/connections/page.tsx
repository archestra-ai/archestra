"use client";

import { Plug, RefreshCw, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { RuntimeCredentialConnectionDialog } from "@/components/runtime-credential-connection-dialog";
import { RuntimeCredentialDisconnectDialog } from "@/components/runtime-credential-disconnect-dialog";
import { RuntimeCredentialRowContent } from "@/components/runtime-credential-row-content";
import { SettingsBlock } from "@/components/settings/settings-block";
import { TableRowActions } from "@/components/table-row-actions";
import { useFeature } from "@/lib/config/config.query";
import {
  type RuntimeCredentialDefinition,
  useDeleteRuntimeCredentialConnection,
  useRuntimeCredentials,
} from "@/lib/runtime-credentials.query";

export default function AccountConnectionsPage() {
  const router = useRouter();
  const runtimeEnabled = useFeature("agentRuntime");
  const byosEnabled = useFeature("byosEnabled");
  const definitions = useRuntimeCredentials(runtimeEnabled === true);
  const [connecting, setConnecting] =
    useState<RuntimeCredentialDefinition | null>(null);
  const [disconnecting, setDisconnecting] =
    useState<RuntimeCredentialDefinition | null>(null);
  const disconnect = useDeleteRuntimeCredentialConnection();
  const personalDefinitions = (definitions.data ?? []).filter(
    (definition) => definition.allowPersonal,
  );

  useEffect(() => {
    if (runtimeEnabled === false) router.replace("/account");
  }, [runtimeEnabled, router]);

  if (runtimeEnabled !== true) return null;

  return (
    <>
      <SettingsBlock
        title="Agent connections"
        description="Connect a credential once, then use it with every Agent that requests it. Connected values stay private to you."
        control={null}
      >
        {definitions.isError ? (
          <QueryLoadError
            title="Couldn't load Agent connections"
            onRetry={() => definitions.refetch()}
          />
        ) : (
          <div className="divide-y overflow-hidden rounded-lg border">
            {personalDefinitions.map((definition) => (
              <div
                key={definition.key}
                className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center"
              >
                <RuntimeCredentialRowContent
                  definition={definition}
                  configured={definition.personalConfigured}
                />
                <div className="self-end sm:self-auto">
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
            {!definitions.isPending && personalDefinitions.length === 0 && (
              <p className="p-5 text-sm text-muted-foreground">
                No personal Agent connections are available.
              </p>
            )}
          </div>
        )}
      </SettingsBlock>

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
    </>
  );
}
