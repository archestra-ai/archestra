"use client";

import { BookOpen, Github, Info, Loader2, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { DebouncedInput } from "@/components/debounced-input";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { GetInternalMcpCatalogResponses } from "@/lib/clients/api";
import type { ArchestraMcpServerManifest } from "@/lib/clients/archestra-catalog";
import { useMcpRegistryServersInfinite } from "@/lib/external-mcp-catalog.query";
import {
  useCreateInternalMcpCatalogItem,
  useInternalMcpCatalog,
} from "@/lib/internal-mcp-catalog.query";
import {
  CatalogFilters,
  type SelectedCategory,
  type ServerType,
} from "./CatalogFilters";
import { DetailsDialog } from "./details-dialog";
import { TransportBadges } from "./transport-badges";

// Server card component for a single server
function ServerCard({
  server,
  onAddToCatalog,
  isAdding,
  onOpenReadme,
  isInCatalog,
}: {
  server: ArchestraMcpServerManifest;
  onAddToCatalog: (server: ArchestraMcpServerManifest) => void;
  isAdding: boolean;
  onOpenReadme: (server: ArchestraMcpServerManifest) => void;
  isInCatalog: boolean;
}) {
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
            <CardTitle className="text-lg">
              <TruncatedText
                message={server.display_name || server.name}
                maxLength={60}
              />
            </CardTitle>
          </div>
          <div className="flex flex-wrap gap-1 items-center flex-shrink-0 mt-1">
            {server.category && (
              <Badge variant="outline" className="text-xs">
                {server.category}
              </Badge>
            )}
            {server.quality_score !== null && (
              <Badge variant="secondary" className="text-xs">
                Quality: {Math.round(server.quality_score)}
              </Badge>
            )}
          </div>
        </div>
        {server.display_name && server.display_name !== server.name && (
          <p className="text-xs text-muted-foreground font-mono">
            {server.name}
          </p>
        )}
        <TransportBadges server={server} className="mt-1" />
      </CardHeader>
      <CardContent className="flex-1 flex flex-col space-y-3">
        {server.description && (
          <p className="text-sm text-muted-foreground line-clamp-3">
            {server.description}
          </p>
        )}

        <div className="flex flex-col gap-2 mt-auto pt-3">
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
            onClick={() => onAddToCatalog(server)}
            disabled={isAdding || isInCatalog}
            size="sm"
            className="w-full"
          >
            {isInCatalog
              ? "Added"
              : isAdding
                ? "Adding..."
                : "Add to Your Registry"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ExternalMCPCatalog({
  catalogItems: initialCatalogItems,
}: {
  catalogItems?: GetInternalMcpCatalogResponses["200"];
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [readmeServer, setReadmeServer] =
    useState<ArchestraMcpServerManifest | null>(null);
  const [filters, setFilters] = useState<{
    type: ServerType;
    category: SelectedCategory;
  }>({
    type: "remote",
    category: "all",
  });

  // Get catalog items for filtering (with live updates)
  const { data: catalogItems } = useInternalMcpCatalog({
    initialData: initialCatalogItems,
  });

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

  const handleAddToCatalog = async (server: ArchestraMcpServerManifest) => {
    await createMutation.mutateAsync({
      name: server.name,
      version: undefined, // No version in archestra catalog
    });
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

  // Use filtered servers
  const displayedServers = filteredServers;

  return (
    <div className="w-full h-full">
      <div className="">
        <h1 className="text-lg font-semibold tracking-tight mb-2">
          External MCP Registry
        </h1>
        <p className="text-sm text-muted-foreground">
          MCP Servers listed below are not available for your agents unless they
          are added to the private registry. Based on{" "}
          <a
            href="https://www.archestra.ai/mcp-catalog"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-primary"
          >
            Archestra MCP Catalog
          </a>
        </p>
      </div>
      <div className="mx-auto py-4 space-y-6">
        {/* Search Bar */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <DebouncedInput
            placeholder="Search servers by name..."
            initialValue={searchQuery}
            onChange={setSearchQuery}
            className="pl-9"
          />
        </div>

        {/* Filters */}
        <CatalogFilters onFiltersChange={setFilters} />

        {/* Loading State */}
        {isLoading && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {Array.from(
              { length: 6 },
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

        {/* Error State */}
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

        {/* Server Cards */}
        {!isLoading && !error && displayedServers && (
          <>
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {displayedServers.length}{" "}
                {displayedServers.length === 1 ? "server" : "servers"} found
              </p>
            </div>

            {displayedServers.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground">
                  No servers match your search criteria.
                </p>
              </div>
            ) : (
              <>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {displayedServers.map((server, index) => (
                    <ServerCard
                      key={`${server.name}-${index}`}
                      server={server}
                      onAddToCatalog={handleAddToCatalog}
                      isAdding={createMutation.isPending}
                      onOpenReadme={setReadmeServer}
                      isInCatalog={catalogServerNames.has(server.name)}
                    />
                  ))}
                </div>

                {/* Load More Button */}
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

        {/* README Dialog */}
        <DetailsDialog
          server={readmeServer}
          onClose={() => setReadmeServer(null)}
        />
      </div>
    </div>
  );
}
