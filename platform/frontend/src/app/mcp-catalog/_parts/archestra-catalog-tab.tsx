"use client";

import {
  type archestraApiTypes,
  type archestraCatalogTypes,
  GITHUB_MCP_SERVER_NAME,
} from "@shared";

import { BookOpen, Github, Info, Loader2, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { DebouncedInput } from "@/components/debounced-input";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useRole } from "@/lib/auth.hook";
import {
  useMcpRegistryServersInfinite,
  useMcpServerCategories,
} from "@/lib/external-mcp-catalog.query";
import {
  useCreateInternalMcpCatalogItem,
  useInternalMcpCatalog,
} from "@/lib/internal-mcp-catalog.query";
import type { SelectedCategory } from "./CatalogFilters";
import { DetailsDialog } from "./details-dialog";
import { RequestInstallationDialog } from "./request-installation-dialog";
import { TransportBadges } from "./transport-badges";

type ServerType = "all" | "remote" | "local";

export function ArchestraCatalogTab({
  catalogItems: initialCatalogItems,
  onClose,
}: {
  catalogItems?: archestraApiTypes.GetInternalMcpCatalogResponses["200"];
  onClose: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [readmeServer, setReadmeServer] =
    useState<archestraCatalogTypes.ArchestraMcpServerManifest | null>(null);
  const [requestServer, setRequestServer] =
    useState<archestraCatalogTypes.ArchestraMcpServerManifest | null>(null);
  const [filters, setFilters] = useState<{
    type: ServerType;
    category: SelectedCategory;
  }>({
    type: "remote",
    category: "all",
  });

  const userRole = useRole();

  // Get catalog items for filtering (with live updates)
  const { data: catalogItems } = useInternalMcpCatalog({
    initialData: initialCatalogItems,
  });

  // Fetch available categories
  const { data: availableCategories = [] } = useMcpServerCategories();

  // Use server-side search and category filtering
  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useMcpRegistryServersInfinite(searchQuery, filters.category);

  // Mutation for adding servers to catalog
  const createMutation = useCreateInternalMcpCatalogItem();

  const handleAddToCatalog = async (
    server: archestraCatalogTypes.ArchestraMcpServerManifest,
  ) => {
    if (server.name === GITHUB_MCP_SERVER_NAME) {
      server.user_config = {
        access_token: {
          sensitive: true,
          type: "string",
          title: "Access Token",
          description: "The access token for the GitHub MCP server",
          required: true,
        },
      };
    }
    // Rewrite redirect URIs to prefer platform callback (port 3000)
    const rewrittenOauth =
      server.oauth_config && !server.oauth_config.requires_proxy
        ? {
            ...server.oauth_config,
            redirect_uris: server.oauth_config.redirect_uris?.map((u) =>
              u === "http://localhost:8080/oauth/callback"
                ? `${window.location.origin}/oauth-callback`
                : u,
            ),
          }
        : undefined;

    await createMutation.mutateAsync({
      name: server.name,
      version: undefined, // No version in archestra catalog
      serverType: server.server.type,
      serverUrl:
        server.server.type === "remote" ? server.server.url : undefined,
      docsUrl:
        server.server.type === "remote"
          ? (server.server.docs_url ?? undefined)
          : undefined,
      userConfig: server.user_config,
      oauthConfig: rewrittenOauth,
    });

    // Close the dialog after adding
    onClose();
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

  // Apply client-side type filter only (categories are filtered backend-side)
  const filteredServers = useMemo(() => {
    let filtered = servers;

    // Filter by type (client-side since API doesn't support this)
    if (filters.type !== "all") {
      filtered = filtered.filter(
        (server) => server.server.type === filters.type,
      );
    }

    return filtered;
  }, [servers, filters.type]);

  // Create a Set of catalog item names for efficient lookup
  const catalogServerNames = useMemo(
    () => new Set(catalogItems?.map((item) => item.name) || []),
    [catalogItems],
  );

  return (
    <div className="w-full space-y-2 mt-4">
      <div className="flex items-end gap-4">
        <div className="flex-1">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <DebouncedInput
              placeholder="Search servers by name..."
              initialValue={searchQuery}
              onChange={setSearchQuery}
              className="pl-9"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-muted-foreground">
            Type
          </span>
          <Select
            value={filters.type}
            onValueChange={(value) =>
              setFilters({ ...filters, type: value as ServerType })
            }
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Select type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="remote">Remote</SelectItem>
              <SelectItem value="local">Local</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-muted-foreground">
            Category
          </span>
          <Select
            value={filters.category}
            onValueChange={(value) =>
              setFilters({ ...filters, category: value as SelectedCategory })
            }
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Select category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {availableCategories.map((category) => (
                <SelectItem key={category} value={category}>
                  {category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading && (
        <div className="grid gap-4 md:grid-cols-2">
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
          <div className="flex items-center justify-between">
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
              <div className="grid gap-4 md:grid-cols-2 max-h-[400px] overflow-y-auto pr-2">
                {filteredServers.map((server, index) => (
                  <ServerCard
                    key={`${server.name}-${index}`}
                    server={server}
                    onAddToCatalog={handleAddToCatalog}
                    onRequestInstallation={handleRequestInstallation}
                    isAdding={createMutation.isPending}
                    onOpenReadme={setReadmeServer}
                    isInCatalog={catalogServerNames.has(server.name)}
                    userRole={userRole}
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

      <DetailsDialog
        server={readmeServer}
        onClose={() => setReadmeServer(null)}
      />

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
  onAddToCatalog,
  onRequestInstallation,
  isAdding,
  onOpenReadme,
  isInCatalog,
  userRole,
}: {
  server: archestraCatalogTypes.ArchestraMcpServerManifest;
  onAddToCatalog: (
    server: archestraCatalogTypes.ArchestraMcpServerManifest,
  ) => void;
  onRequestInstallation: (
    server: archestraCatalogTypes.ArchestraMcpServerManifest,
  ) => void;
  isAdding: boolean;
  onOpenReadme: (
    server: archestraCatalogTypes.ArchestraMcpServerManifest,
  ) => void;
  isInCatalog: boolean;
  userRole: "admin" | "member";
}) {
  const isAdmin = userRole === "admin";
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-start">
          <div className="flex items-start gap-2 flex-1 min-w-0">
            {server.icon && (
              <img
                src={server.icon}
                alt={`${server.name} icon`}
                className="w-8 h-8 rounded flex-shrink-0 mt-0.5"
              />
            )}
            <CardTitle className="text-base">
              <TruncatedText
                message={server.display_name || server.name}
                maxLength={40}
              />
            </CardTitle>
          </div>
          <div className="flex flex-wrap gap-1 items-center flex-shrink-0 mt-1">
            {server.category && (
              <Badge variant="outline" className="text-xs">
                {server.category}
              </Badge>
            )}
            {!server.oauth_config?.requires_proxy && (
              <Badge variant="secondary" className="text-xs">
                OAuth
              </Badge>
            )}
          </div>
        </div>
        {server.display_name && server.display_name !== server.name && (
          <p className="text-xs text-muted-foreground font-mono">
            {server.name}
          </p>
        )}
        <TransportBadges
          isRemote={server.server.type === "remote"}
          className="mt-1"
        />
      </CardHeader>
      <CardContent className="flex-1 flex flex-col space-y-3">
        {server.description && (
          <p className="text-sm text-muted-foreground line-clamp-2">
            {server.description}
          </p>
        )}

        <div className="flex flex-col gap-2 mt-auto pt-3 justify-end">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenReadme(server)}
              className="flex-1"
            >
              <Info className="h-4 w-4 mr-1" />
              Details
            </Button>
            {server.github_info?.url && (
              <Button variant="outline" size="sm" asChild className="flex-1">
                <a
                  href={server.github_info.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Github className="h-4 w-4 mr-1" />
                  Code
                </a>
              </Button>
            )}
            {(server.homepage || server.documentation) && (
              <Button variant="outline" size="sm" asChild className="flex-1">
                <a
                  href={server.homepage || server.documentation}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <BookOpen className="h-4 w-4 mr-1" />
                  Docs
                </a>
              </Button>
            )}
          </div>
          <Button
            onClick={() =>
              isAdmin ? onAddToCatalog(server) : onRequestInstallation(server)
            }
            disabled={isAdding || isInCatalog}
            size="sm"
            className="w-full"
          >
            {isInCatalog
              ? "Added"
              : isAdmin
                ? "Add to Your Registry"
                : "Request to add to internal registry"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
