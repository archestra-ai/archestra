"use client";

import { Globe, Pencil, Server } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CatalogItem } from "./mcp-server-card";

/**
 * Sectioned, read-first view of a server's configuration on the detail page —
 * the "edit is an overview, not a wizard" direction. Each card summarizes one
 * concern; Edit opens the focused configuration form.
 *
 * Prototype: the per-card Edit actions all lead to the existing form. The
 * target state is editing each section in place.
 */
export function ConfigurationTab({
  item,
  canModify,
}: {
  item: CatalogItem;
  canModify: boolean;
}) {
  const localConfig = item.localConfig;
  const environment = localConfig?.environment ?? [];
  const headerFields = Object.entries(item.userConfig ?? {}).filter(
    ([, config]) =>
      typeof (config as { headerName?: string })?.headerName === "string",
  );

  const authSummary = item.enterpriseManagedConfig
    ? item.enterpriseManagedConfig.assertionMode === "passthrough"
      ? "Identity provider JWT passthrough"
      : "Enterprise-managed token exchange"
    : item.oauthConfig
      ? item.oauthConfig.grant_type === "client_credentials"
        ? "OAuth (client credentials)"
        : "OAuth"
      : item.userConfig?.access_token || item.userConfig?.raw_access_token
        ? "Bearer token, requested when connecting"
        : headerFields.length > 0
          ? "Custom headers"
          : "None";

  const editHref = `/mcp/registry/${item.id}/edit?step=configuration`;

  // No JSON surface here: the detail page is a read-first summary. The MCP
  // JSON block lives embedded in the edit form's Connection card — the one
  // place the config is viewed, exported, or imported as JSON.
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ConfigCard title="Runtime" editHref={editHref} canModify={canModify}>
        <ConfigRow label="Type">
          {item.serverType === "remote" ? (
            <Badge variant="outline" className="gap-1">
              <Globe className="h-3 w-3" />
              <span>Remote</span>
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1">
              <Server className="h-3 w-3" />
              <span>Self-hosted</span>
            </Badge>
          )}
        </ConfigRow>
        {item.serverType === "remote" ? (
          <ConfigRow label="URL">
            <span className="break-all font-mono text-sm">
              {item.serverUrl || "—"}
            </span>
          </ConfigRow>
        ) : (
          <>
            {localConfig?.command && (
              <ConfigRow label="Command">
                <span className="break-all font-mono text-sm">
                  {[localConfig.command, ...(localConfig.arguments ?? [])]
                    .join(" ")
                    .slice(0, 200)}
                </span>
              </ConfigRow>
            )}
            {localConfig?.dockerImage && (
              <ConfigRow label="Image">
                <span className="break-all font-mono text-sm">
                  {localConfig.dockerImage}
                </span>
              </ConfigRow>
            )}
            <ConfigRow label="Transport">
              <span className="text-sm">
                {localConfig?.transportType === "streamable-http"
                  ? `Streamable HTTP · port ${localConfig?.httpPort ?? 8080}`
                  : "stdio"}
              </span>
            </ConfigRow>
          </>
        )}
      </ConfigCard>

      <ConfigCard
        title="Authentication"
        editHref={editHref}
        canModify={canModify}
      >
        <ConfigRow label="Method">
          <span className="text-sm">{authSummary}</span>
        </ConfigRow>
        {headerFields.length > 0 && (
          <ConfigRow label="Headers">
            <span className="flex flex-wrap gap-1">
              {headerFields.map(([fieldName, config]) => (
                <Badge
                  key={fieldName}
                  variant="outline"
                  className="font-mono font-normal"
                >
                  {(config as { headerName: string }).headerName}
                </Badge>
              ))}
            </span>
          </ConfigRow>
        )}
      </ConfigCard>

      {item.serverType === "local" && (
        <ConfigCard
          title="Environment variables"
          editHref={editHref}
          canModify={canModify}
        >
          {environment.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No environment variables configured.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {environment.map((env) => (
                <Badge
                  key={env.key}
                  variant="outline"
                  className="font-mono font-normal"
                >
                  {env.key}
                  {env.type === "secret" && (
                    <span className="ml-1 text-muted-foreground">· secret</span>
                  )}
                  {env.promptOnInstallation && (
                    <span className="ml-1 text-muted-foreground">
                      · prompted
                    </span>
                  )}
                </Badge>
              ))}
            </div>
          )}
        </ConfigCard>
      )}

      <ConfigCard
        title="Sharing &amp; placement"
        editHref={editHref}
        canModify={canModify}
      >
        <ConfigRow label="Access">
          <span className="text-sm capitalize">{item.scope ?? "org"}</span>
        </ConfigRow>
        <ConfigRow label="Environment">
          <span className="text-sm">
            {item.environmentId ? "Assigned environment" : "Default"}
          </span>
        </ConfigRow>
        {(item.labels?.length ?? 0) > 0 && (
          <ConfigRow label="Labels">
            <span className="flex flex-wrap gap-1">
              {item.labels?.map((label) => (
                <Badge
                  key={`${label.key}:${label.value}`}
                  variant="outline"
                  className="font-normal"
                >
                  {label.key}={label.value}
                </Badge>
              ))}
            </span>
          </ConfigRow>
        )}
      </ConfigCard>

      {item.serverType === "local" && (
        <ConfigCard title="Advanced" editHref={editHref} canModify={canModify}>
          <ConfigRow label="Tenancy">
            <span className="text-sm">
              {item.multitenant ? "Multi-tenant" : "Single-tenant"}
            </span>
          </ConfigRow>
          <ConfigRow label="Deployment YAML">
            <span className="text-sm">
              {item.deploymentSpecYaml ? "Customized" : "Generated default"}
            </span>
          </ConfigRow>
        </ConfigCard>
      )}
    </div>
  );
}

function ConfigCard({
  title,
  editHref,
  canModify,
  children,
}: {
  title: React.ReactNode;
  editHref: string;
  canModify: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        {canModify && (
          <Button variant="ghost" size="sm" asChild>
            <Link href={editHref}>
              <Pencil className="h-3.5 w-3.5" />
              <span>Edit</span>
            </Link>
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2">{children}</CardContent>
    </Card>
  );
}

function ConfigRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-24 shrink-0 text-sm text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}
