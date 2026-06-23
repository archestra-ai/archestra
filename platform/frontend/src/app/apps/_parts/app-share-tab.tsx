"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { CopyableCode } from "@/components/copyable-code";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Skeleton } from "@/components/ui/skeleton";
import { usePublicBaseUrl } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";

export function AppShareTab({ appId }: { appId: string }) {
  const baseUrl = usePublicBaseUrl();
  const appName = useAppName();

  return (
    <div className="max-w-2xl space-y-4 py-2">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Connector URL</h3>
        <p className="text-sm text-muted-foreground">
          Add this app to an external MCP client (e.g. Claude Desktop &rarr;
          Settings &rarr; Connectors &rarr; Add custom connector) by pasting
          this URL. Whoever connects authenticates as themselves and runs the
          app with their own access, so sharing the URL grants nothing on its
          own.
        </p>
      </div>

      {baseUrl ? (
        <CopyableCode
          value={`${baseUrl}/api/mcp/app/${appId}`}
          toastMessage="Connector URL copied"
          variant="primary"
        />
      ) : (
        <Skeleton className="h-10 w-full" />
      )}

      <ExternalDocsLink href={getDocsUrl(DocsPage.PlatformApps)}>
        Learn about {appName} apps
      </ExternalDocsLink>
    </div>
  );
}
