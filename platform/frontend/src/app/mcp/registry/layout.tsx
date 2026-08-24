"use client";

import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { PermissionButton } from "@/components/ui/permission-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import {
  useMcpDeploymentStatuses,
  useMcpServers,
} from "@/lib/mcp/mcp-server.query";
import { useMcpServerIssues } from "@/lib/mcp/use-mcp-server-issues";
import { waitingActionFacetLabel } from "./_parts/mcp-server-attention-owner";
import {
  ATTENTION_FACET_STATUS_VALUES,
  mcpRegistryFacetHref,
  REGISTRY_STATUS_PARAM,
  selectedAttentionFacet,
} from "./_parts/registry-list-controls";

/**
 * The registry used to answer "what needs me?" on a second tab, which meant
 * the same server was counted on the tab and listed on the tab but missing
 * from the list everyone actually works in. The tab is gone; the question is
 * now a facet of the one list. Links people already have keep working.
 */
const RETIRED_ATTENTION_TAB_PARAM = "tab";
const RETIRED_ATTENTION_TAB_VALUE = "attention";

export default function McpCatalogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMainRegistry = pathname === "/mcp/registry";

  // Path-exact: `tab` means something else on the server detail page, so only
  // the list route redirects. `replace` keeps the retired URL out of history,
  // where Back would bounce the user straight through it again.
  const retiredAttentionTab =
    isMainRegistry &&
    searchParams.get(RETIRED_ATTENTION_TAB_PARAM) ===
      RETIRED_ATTENTION_TAB_VALUE;
  useEffect(() => {
    if (!retiredAttentionTab) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete(RETIRED_ATTENTION_TAB_PARAM);
    params.set(REGISTRY_STATUS_PARAM, ATTENTION_FACET_STATUS_VALUES.you);
    router.replace(`/mcp/registry?${params.toString()}`, { scroll: false });
  }, [retiredAttentionTab, searchParams, router]);

  const registrySubPath = pathname.startsWith("/mcp/registry/")
    ? pathname.slice("/mcp/registry/".length)
    : null;

  // The server detail page renders its own PageLayout, whose header band spans
  // the full width and supplies its own padding. Wrapping it in the padded
  // container below would inset that band and double its horizontal padding,
  // so this route is handed through untouched.
  const isServerDetailPage =
    !!registrySubPath &&
    !registrySubPath.includes("/") &&
    !REGISTRY_NON_DETAIL_ROUTES.includes(registrySubPath);
  if (isServerDetailPage) {
    return <>{children}</>;
  }

  // Edit/new/catalog pages carry their own headers — render bare content (no
  // overflow wrapper, so in-page sticky footers pin to the viewport).
  const isFullPage = pathname.startsWith("/mcp/registry/");
  if (isFullPage) {
    return <div className="mx-auto w-full px-6 py-6 md:px-6">{children}</div>;
  }

  return isMainRegistry ? (
    <McpRegistryListLayout onAdd={() => router.push("/mcp/registry/new")}>
      {children}
    </McpRegistryListLayout>
  ) : (
    <PageLayout
      title="MCP Registry"
      description={
        <>
          Manage your own list of MCP servers and make them available to agents.
        </>
      }
    >
      {children}
    </PageLayout>
  );
}

function McpRegistryListLayout({
  children,
  onAdd,
}: {
  children: React.ReactNode;
  onAdd: () => void;
}) {
  const searchParams = useSearchParams();
  const alertingEnabled = useFeature("mcpServerAlertingEnabled") === true;
  const { data: catalogItems } = useInternalMcpCatalog();
  const { data: servers } = useMcpServers();
  const { statuses } = useMcpDeploymentStatuses();
  const { issuesByCatalog, facetCounts } = useMcpServerIssues(statuses);
  const { data: userIsMcpServerAdmin } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });
  const selectedFacet = selectedAttentionFacet(
    new Set(searchParams.getAll(REGISTRY_STATUS_PARAM)),
  );
  const totalCount = (catalogItems ?? []).filter(
    (item) => item.id !== ARCHESTRA_MCP_CATALOG_ID,
  ).length;
  const othersLabel = waitingActionFacetLabel({
    issuesByCatalog,
    servers: servers ?? [],
  });
  const tabs = alertingEnabled
    ? [
        {
          label: <RegistryTabLabel label="All" count={totalCount} />,
          href: "/mcp/registry",
          active: selectedFacet === null,
        },
        {
          label: (
            <RegistryTabLabel
              label="Action required"
              count={facetCounts.you}
              beta
            />
          ),
          href: mcpRegistryFacetHref("you"),
          active: selectedFacet === "you",
          testId: "mcp-registry-action-required-tab",
        },
        ...(!userIsMcpServerAdmin && facetCounts.others > 0
          ? [
              {
                label: (
                  <RegistryTabLabel
                    label={othersLabel}
                    count={facetCounts.others}
                  />
                ),
                href: mcpRegistryFacetHref("others"),
                active: selectedFacet === "others",
              },
            ]
          : []),
        ...(facetCounts.muted > 0
          ? [
              {
                label: (
                  <RegistryTabLabel
                    label="Dismissed"
                    count={facetCounts.muted}
                  />
                ),
                href: mcpRegistryFacetHref("muted"),
                active: selectedFacet === "muted",
              },
            ]
          : []),
      ]
    : [];

  return (
    <PageLayout
      title="MCP Registry"
      description="Manage your own list of MCP servers and make them available to agents."
      tabs={tabs}
      actionButton={
        <PermissionButton
          permissions={{ mcpRegistry: ["create"] }}
          onClick={onAdd}
        >
          <Plus className="h-4 w-4" />
          <span>Add MCP Server</span>
        </PermissionButton>
      }
    >
      {children}
    </PageLayout>
  );
}

function RegistryTabLabel({
  label,
  count,
  beta = false,
}: {
  label: string;
  count: number;
  beta?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{label}</span>
      <span className="tabular-nums text-muted-foreground">({count})</span>
      {beta ? (
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          Beta
        </Badge>
      ) : null}
    </span>
  );
}

/**
 * Single-segment routes under `/mcp/registry/` that are not a server id, and so
 * are not the server detail page.
 */
const REGISTRY_NON_DETAIL_ROUTES = ["new", "catalog"];
