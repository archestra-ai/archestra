"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useInitiateOAuth } from "@/lib/auth/oauth.query";
import {
  setOAuthCatalogId,
  setOAuthMcpServerId,
  setOAuthReturnUrl,
  setOAuthState,
} from "@/lib/auth/oauth-session";
import { useReauthenticateMcpServer } from "@/lib/mcp/mcp-server.query";
import { buildRemoteInstallCredentialPayload } from "@/lib/mcp/remote-install-payload";
import { LocalServerInstallDialog } from "./local-server-install-dialog";
import type { CatalogItem, InstalledServer } from "./mcp-server-card";
import { RemoteServerInstallDialog } from "./remote-server-install-dialog";
import type { McpServerInstallScope } from "./select-mcp-server-credential-type-and-teams";

export function InlineMcpReauthentication({
  item,
  server,
  onClose,
  onCompleted,
}: {
  item: CatalogItem;
  server: InstalledServer;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const reauthenticate = useReauthenticateMcpServer();
  const initiateOAuth = useInitiateOAuth();
  const existingScope = (server.scope ??
    (server.teamId ? "team" : "personal")) as McpServerInstallScope;
  const hasPromptableUserConfig = Object.values(item.userConfig ?? {}).some(
    (config) => config.promptOnInstallation !== false,
  );
  const hasPromptableLocalSecret = (item.localConfig?.environment ?? []).some(
    (config) =>
      config.promptOnInstallation !== false && config.type === "secret",
  );
  const pureOAuth = !!item.oauthConfig && !hasPromptableUserConfig;

  const updateCredentials = async (body: {
    environmentValues?: Record<string, string>;
    userConfigValues?: Record<string, string>;
    accessToken?: string;
    isByosVault?: boolean;
  }) => {
    const updated = await reauthenticate.mutateAsync({
      id: server.id,
      name: server.name,
      ...body,
    });
    if (updated) onCompleted();
  };

  // Pure OAuth has nothing to fill in, so asking first adds a step that says
  // nothing: picking "Re-authenticate" or "Sign in" goes straight to the
  // provider. Started once per mount; the return URL drops the server
  // selection so a failed sign-in does not bounce straight back out.
  const started = useRef(false);
  useEffect(() => {
    if (!pureOAuth || started.current) return;
    started.current = true;
    void (async () => {
      try {
        setOAuthMcpServerId(server.id);
        const { authorizationUrl, state } = await initiateOAuth.mutateAsync({
          catalogId: item.id,
          serverId: server.id,
        });
        setOAuthState(state);
        setOAuthCatalogId(item.id);
        const returnUrl = new URL(window.location.href);
        returnUrl.searchParams.delete("server");
        setOAuthReturnUrl(returnUrl.toString());
        window.location.href = authorizationUrl;
      } catch (error) {
        setOAuthMcpServerId(null);
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to start re-authentication",
        );
        onClose();
      }
    })();
  }, [pureOAuth, server.id, item.id, initiateOAuth, onClose]);

  if (pureOAuth) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="inline-mcp-reauthentication-form"
      >
        Redirecting to sign in…
      </p>
    );
  }

  if (!hasPromptableUserConfig && !hasPromptableLocalSecret) {
    return (
      <section
        className="rounded-lg border bg-muted/20 p-4"
        data-testid="inline-mcp-reauthentication-form"
      >
        <h3 className="font-medium">Credentials cannot be replaced here</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          This catalog entry has no credential fields configured. Add the
          required authentication fields before repairing this connection.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button asChild>
            <Link href={`/mcp/registry/${item.id}/edit?step=configuration`}>
              Edit configuration
            </Link>
          </Button>
        </div>
      </section>
    );
  }

  if (item.serverType === "local") {
    return (
      <LocalServerInstallDialog
        presentation="inline"
        isOpen
        onClose={onClose}
        onConfirm={async (result) =>
          updateCredentials({
            environmentValues: result.environmentValues,
            userConfigValues: result.userConfigValues,
            isByosVault: result.isByosVault,
          })
        }
        catalogItem={item}
        isInstalling={reauthenticate.isPending}
        isReauth
        existingTeamId={server.teamId}
        existingScope={existingScope}
      />
    );
  }

  return (
    <RemoteServerInstallDialog
      presentation="inline"
      isOpen
      onClose={onClose}
      onConfirm={async (_catalogItem, result) =>
        updateCredentials(
          buildRemoteInstallCredentialPayload({
            metadata: result.metadata,
            isByosVault: result.isByosVault,
          }),
        )
      }
      catalogItem={item}
      isInstalling={reauthenticate.isPending}
      isReauth
      existingTeamId={server.teamId}
      existingScope={existingScope}
    />
  );
}
