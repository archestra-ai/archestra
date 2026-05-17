import type { AuthRequiredAction } from "@shared";
import { AuthErrorTool } from "./auth-error-tool";

interface AuthRequiredToolProps {
  toolName: string;
  catalogName: string;
  actionUrl: string;
  action: AuthRequiredAction;
  providerId?: string | null;
  /** When provided, opens the MCP credential install dialog inline. */
  onInstall?: () => void;
}

export function AuthRequiredTool({
  catalogName,
  actionUrl,
  action,
  providerId,
  onInstall,
}: AuthRequiredToolProps) {
  const isIdentityProviderConnect = action === "connect_identity_provider";
  const providerName = providerId ?? "identity provider";

  return (
    <AuthErrorTool
      title="Authentication Required"
      description={
        isIdentityProviderConnect ? (
          `Connect ${providerName}. This deployment can then request the downstream credential for "${catalogName}".`
        ) : (
          <>
            No credentials found for &ldquo;{catalogName}&rdquo;. Set up your
            credentials to use this tool.
          </>
        )
      }
      buttonText={
        isIdentityProviderConnect
          ? `Connect ${providerName}`
          : "Set up credentials"
      }
      buttonUrl={actionUrl}
      onAction={isIdentityProviderConnect ? undefined : onInstall}
      openInNewTab={!isIdentityProviderConnect}
    />
  );
}
