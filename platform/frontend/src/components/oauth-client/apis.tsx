"use client";

import { oauthCapabilities } from "@/components/oauth-client/configuration-fields";
import { Badge } from "@/components/ui/badge";

/** The APIs an OAuth client reaches, one badge each, in a fixed order. */
export function OAuthClientApis({ scopes }: { scopes: readonly string[] }) {
  const enabled = oauthCapabilities.filter(({ scope }) =>
    scopes.includes(scope),
  );
  if (enabled.length === 0)
    return <span className="text-muted-foreground">None</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {enabled.map(({ scope, label, icon: Icon }) => (
        <Badge key={scope} variant="secondary" className="gap-1">
          <Icon className="size-3" />
          <span>{label}</span>
        </Badge>
      ))}
    </span>
  );
}
