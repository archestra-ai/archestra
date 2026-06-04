"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { useIdentityProviderLatestIdTokenClaims } from "@/lib/auth/identity-provider.query.ee";

interface IdTokenClaimsDebuggerProps {
  identityProviderId?: string;
}

export function IdTokenClaimsDebugger({
  identityProviderId,
}: IdTokenClaimsDebuggerProps) {
  const { data, isLoading } =
    useIdentityProviderLatestIdTokenClaims(identityProviderId);

  if (!identityProviderId) {
    return null;
  }

  const formattedIdTokenClaims = formatClaims(data?.claims);
  const formattedAccessTokenClaims = formatClaims(data?.accessTokenClaims);
  const accessTokenWarnings = getAccessTokenWarnings(data?.accessTokenClaims);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h3 className="text-lg font-medium">
          Latest identity-provider token claims
        </h3>
        <p className="text-sm text-muted-foreground">
          Decoded claims from your latest sign-in with this identity provider.
          Raw signed tokens are never shown.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading claims...</p>
      ) : (
        <div className="space-y-6">
          <TokenClaimsPanel
            title="Latest access token claims"
            description="Used when downstream tools receive or exchange the signed-in user's identity-provider access token."
            formattedClaims={formattedAccessTokenClaims}
            emptyMessage="No access token claims are available for your account yet."
            warnings={accessTokenWarnings}
          />
          <TokenClaimsPanel
            title="Latest ID token claims"
            description="Used for SSO mapping, role mapping, and team sync debugging."
            formattedClaims={formattedIdTokenClaims}
            emptyMessage="No ID token claims are available for your account yet."
          />
        </div>
      )}
    </div>
  );
}

function TokenClaimsPanel({
  description,
  emptyMessage,
  formattedClaims,
  title,
  warnings = [],
}: {
  description: string;
  emptyMessage: string;
  formattedClaims: string | null;
  title: string;
  warnings?: string[];
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h4 className="text-sm font-medium">{title}</h4>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      {warnings.length > 0 && (
        <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}

      {formattedClaims ? (
        <ScrollArea className="h-80 overflow-auto rounded-md border bg-muted/40">
          <pre className="p-3 text-xs leading-relaxed whitespace-pre-wrap break-words font-mono">
            {formattedClaims}
          </pre>
        </ScrollArea>
      ) : (
        <p className="text-sm text-muted-foreground">
          {emptyMessage} Sign in with this provider, then reopen this dialog.
        </p>
      )}
    </section>
  );
}

function formatClaims(claims: Record<string, unknown> | null | undefined) {
  return claims ? JSON.stringify(claims, null, 2) : null;
}

function getAccessTokenWarnings(
  claims: Record<string, unknown> | null | undefined,
): string[] {
  if (!claims) {
    return [];
  }

  const warnings: string[] = [];
  if (!("scp" in claims)) {
    warnings.push(
      "No scp claim found. Entra delegated access tokens usually include scp.",
    );
  }
  if ("roles" in claims && !("scp" in claims)) {
    warnings.push(
      "roles is present without scp, which usually indicates an app-only token.",
    );
  }
  return warnings;
}
