"use client";

import {
  type archestraApiTypes,
  type archestraCatalogTypes,
  E2eTestId,
} from "@archestra/shared";

import {
  BookOpen,
  Check,
  Github,
  Loader2,
  Plus,
  Search,
  Server as ServerIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { DebouncedInput } from "@/components/debounced-input";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useMcpRegistryServersInfinite,
  useMcpServerCategories,
} from "@/lib/mcp/external-mcp-catalog.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import type { SelectedCategory } from "../../_parts/CatalogFilters";
import type { McpCatalogFormValues } from "../../_parts/mcp-catalog-form.types";
import { transformExternalCatalogToFormValues } from "../../_parts/mcp-catalog-form.utils";
import { RequestInstallationDialog } from "../../_parts/request-installation-dialog";

// "mcp-apps-demo" is a pseudo-type: demo servers are marked with the
// MCP_APPS_DEMO_CATEGORY catalog category, hidden from every other type view,
// and revealed only by picking this type explicitly.
type ServerType = "all" | "remote" | "local" | "mcp-apps-demo";

// Catalog category reserved for servers that only exist to exercise the MCP
// Apps feature. Surfaced in the UI as the "MCP Apps Demo" type, not as a
// selectable category.
const MCP_APPS_DEMO_CATEGORY = "MCP Apps Demo";

// Typed to accept a plain string so it composes with both the generated
// category union and the server manifest's nullable category without casts.
const isDemoCategory = (category: string | null | undefined) =>
  category === MCP_APPS_DEMO_CATEGORY;

export function ArchestraCatalogTab({
  catalogItems: initialCatalogItems,
  onSelectServer,
}: {
  catalogItems?: archestraApiTypes.GetInternalMcpCatalogResponses["200"];
  onSelectServer: (formValues: McpCatalogFormValues) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [requestServer, setRequestServer] =
    useState<archestraCatalogTypes.ArchestraMcpServerManifest | null>(null);
  const [filters, setFilters] = useState<{
    type: ServerType;
    category: SelectedCategory;
  }>({
    type: "all",
    category: "all",
  });

  // Get catalog items for filtering (with live updates)
  const { data: catalogItems } = useInternalMcpCatalog({
    initialData: initialCatalogItems,
  });

  // Fetch available categories
  const { data: availableCategories = [] } = useMcpServerCategories();

  const { data: userAllowedToCreateCatalogItem = false } = useHasPermissions({
    mcpRegistry: ["create"],
  });

  // Use server-side search and category filtering. The demo pseudo-type maps
  // onto its backend category so filtering happens server-side — a client-only
  // filter would miss demo servers beyond the first page.
  const effectiveCategory: SelectedCategory =
    filters.type === "mcp-apps-demo"
      ? MCP_APPS_DEMO_CATEGORY
      : filters.category;
  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useMcpRegistryServersInfinite(searchQuery, effectiveCategory);

  const handleSelectServer = (
    server: archestraCatalogTypes.ArchestraMcpServerManifest,
  ) => {
    const formValues = transformExternalCatalogToFormValues(server);
    onSelectServer(formValues);
  };

  const handleRequestInstallation = async (
    server: archestraCatalogTypes.ArchestraMcpServerManifest,
  ) => {
    // Just open the request dialog with the server data
    setRequestServer(server);
  };

  // Flatten all pages into a single array of servers
  const servers = useMemo(() => {
    if (!data) return [];
    return data.pages.flatMap((page) => page.servers);
  }, [data]);

  // Apply client-side type filter (categories are filtered backend-side).
  const filteredServers = useMemo(() => {
    // The demo pseudo-type shows only MCP Apps demo servers.
    if (filters.type === "mcp-apps-demo") {
      return servers.filter((server) => isDemoCategory(server.category));
    }

    // Demo servers are hidden from every other type view, including "all".
    let filtered = servers.filter((server) => !isDemoCategory(server.category));
    if (filters.type !== "all") {
      filtered = filtered.filter(
        (server) => server.server.type === filters.type,
      );
    }

    return filtered;
  }, [servers, filters.type]);

  // The demo marker is surfaced as a type, so keep it out of the category list.
  const visibleCategories = useMemo(
    () => availableCategories.filter((category) => !isDemoCategory(category)),
    [availableCategories],
  );

  // Create a Set of catalog item names for efficient lookup
  const catalogServerNames = useMemo(
    () => new Set(catalogItems?.map((item) => item.name) || []),
    [catalogItems],
  );

  return (
    <div className="w-full space-y-2">
      <div className="ml-1 grid grid-cols-1 items-end gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,0.5fr)_minmax(0,0.5fr)]">
        <div className="min-w-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <DebouncedInput
              placeholder="Search servers by name..."
              initialValue={searchQuery}
              onChange={setSearchQuery}
              className="pl-9"
              autoFocus
            />
          </div>
        </div>

        <div className="min-w-0">
          <Select
            value={filters.type}
            onValueChange={(value) =>
              setFilters({ ...filters, type: value as ServerType })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="remote">Remote</SelectItem>
              <SelectItem value="local">Local</SelectItem>
              <SelectItem value="mcp-apps-demo">MCP Apps Demo</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-0">
          <Select
            value={filters.category}
            onValueChange={(value) =>
              setFilters({ ...filters, category: value as SelectedCategory })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {visibleCategories.map((category) => (
                <SelectItem key={category} value={category}>
                  {category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading && (
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from(
            { length: 4 },
            (_, i) => `skeleton-${i}-${Date.now()}`,
          ).map((key) => (
            <Card key={key}>
              <CardHeader>
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-4 w-1/2 mt-2" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full mt-2" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {error && (
        <div className="text-center py-12">
          <p className="text-destructive mb-2">
            Failed to load servers from the external catalog
          </p>
          <p className="text-sm text-muted-foreground">
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        </div>
      )}

      {!isLoading && !error && filteredServers && (
        <>
          <div className="flex items-center justify-between ml-1">
            <p className="text-sm text-muted-foreground">
              {filteredServers.length}{" "}
              {filteredServers.length === 1 ? "server" : "servers"} found
            </p>
          </div>

          {filteredServers.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground">
                No servers match your search criteria.
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-3 overflow-y-auto">
                {filteredServers.map((server) => (
                  <ServerCard
                    key={server.name}
                    server={server}
                    onSelectServer={handleSelectServer}
                    onRequestInstallation={handleRequestInstallation}
                    isInCatalog={catalogServerNames.has(server.name)}
                    userAllowedToCreateCatalogItem={
                      userAllowedToCreateCatalogItem
                    }
                  />
                ))}
              </div>

              {hasNextPage && (
                <div className="flex justify-center mt-6">
                  <Button
                    onClick={() => fetchNextPage()}
                    disabled={isFetchingNextPage}
                    variant="outline"
                    size="lg"
                  >
                    {isFetchingNextPage ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Loading more...
                      </>
                    ) : (
                      "Load more"
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}

      <RequestInstallationDialog
        server={requestServer}
        onClose={() => setRequestServer(null)}
      />
    </div>
  );
}

// Server card component for a single server
function ServerCard({
  server,
  onSelectServer,
  onRequestInstallation,
  isInCatalog,
  userAllowedToCreateCatalogItem,
}: {
  server: archestraCatalogTypes.ArchestraMcpServerManifest;
  onSelectServer: (
    server: archestraCatalogTypes.ArchestraMcpServerManifest,
  ) => void;
  onRequestInstallation: (
    server: archestraCatalogTypes.ArchestraMcpServerManifest,
  ) => void;
  isInCatalog: boolean;
  userAllowedToCreateCatalogItem: boolean;
}) {
  // Where the server comes from: hosted remote endpoint, or a GitHub-sourced
  // server the org hosts itself. GitHub-sourced servers are community-built
  // unless they live in the official modelcontextprotocol org.
  const isOfficialSource = server.github_info?.owner === "modelcontextprotocol";
  const sourceBadges =
    server.server.type === "remote"
      ? ["Remote"]
      : server.github_info && !isOfficialSource
        ? ["Self-hosted", "Community"]
        : ["Self-hosted"];
  const docsUrl = server.homepage || server.documentation;

  return (
    <Card className="gap-2 rounded-xl p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
          {server.icon ? (
            <img
              src={server.icon}
              alt={`${server.name} icon`}
              className="h-6 w-6 rounded"
            />
          ) : (
            <ServerIcon className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <span className="block truncate font-semibold">
            <TruncatedText
              message={server.display_name || server.name}
              maxLength={40}
            />
          </span>
        </div>
        <div className="flex shrink-0 items-center">
          {docsUrl && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              asChild
            >
              <a
                href={docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Docs"
              >
                <BookOpen className="h-4 w-4" />
              </a>
            </Button>
          )}
          {server.github_info?.url && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              asChild
            >
              <a
                href={server.github_info.url}
                target="_blank"
                rel="noopener noreferrer"
                title="GitHub"
              >
                <Github className="h-4 w-4" />
              </a>
            </Button>
          )}
          <Button
            variant={isInCatalog ? "ghost" : "default"}
            size="icon"
            className="h-8 w-8"
            disabled={isInCatalog}
            title={
              isInCatalog
                ? "Added"
                : userAllowedToCreateCatalogItem
                  ? "Use as template"
                  : "Request to add to internal registry"
            }
            onClick={() =>
              userAllowedToCreateCatalogItem
                ? onSelectServer(server)
                : onRequestInstallation(server)
            }
            data-testid={E2eTestId.AddCatalogItemButton}
          >
            {isInCatalog ? (
              <Check className="h-4 w-4 text-muted-foreground" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {sourceBadges.map((badge) => (
          <Badge key={badge} variant="secondary" className="text-xs">
            {badge}
          </Badge>
        ))}
      </div>
      {server.description && (
        <p className="text-sm text-muted-foreground line-clamp-2">
          {server.description}
        </p>
      )}
    </Card>
  );
}
