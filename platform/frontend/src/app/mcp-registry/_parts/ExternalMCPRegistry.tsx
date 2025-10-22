"use client";

import {
  BookOpen,
  ChevronDown,
  Github,
  Info,
  Loader2,
  Search,
} from "lucide-react";
import { useMemo, useState } from "react";
import { DebouncedInput } from "@/components/debounced-input";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import type { GetMcpCatalogResponses } from "@/lib/clients/api";
import type { ServerResponse } from "@/lib/clients/mcp-registry";
import {
  useCreateMcpCatalogItem,
  useMcpCatalog,
} from "@/lib/mcp-catalog.query";
import {
  useMcpRegistryServersInfinite,
  useMcpServerVersion,
  useMcpServerVersions,
} from "@/lib/mcp-registry-external.query";
import { DetailsDialog } from "./details-dialog";
import { TransportBadges } from "./transport-badges";

// Server card component that handles version fetching for a single server
function ServerCard({
  serverResponse,
  onAddToCatalog,
  isAdding,
  onOpenReadme,
  isInCatalog,
}: {
  serverResponse: ServerResponse;
  onAddToCatalog: (server: ServerResponse) => void;
  isAdding: boolean;
  onOpenReadme: (server: ServerResponse) => void;
  isInCatalog: boolean;
}) {
  const server = serverResponse.server;
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [versionsDropdownOpen, setVersionsDropdownOpen] = useState(false);

  // Fetch all versions when dropdown is open
  const { data: versionsData } = useMcpServerVersions(
    versionsDropdownOpen ? server.name : null,
  );
  const availableVersions = useMemo(
    () => versionsData?.servers || [],
    [versionsData],
  );

  // Fetch specific version when selected
  const { data: selectedVersionData } = useMcpServerVersion(
    server.name,
    selectedVersion,
  );

  // Determine which server data to display
  const displayedServer = selectedVersionData || serverResponse;

  // Get the first icon if available
  const serverIcon = displayedServer.server.icons?.[0];

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2 flex-1 min-w-0">
            {serverIcon && (
              <img
                src={serverIcon.src}
                alt={`${server.name} icon`}
                className="w-8 h-8 rounded flex-shrink-0 mt-0.5"
              />
            )}
            <CardTitle className="text-lg">
              <TruncatedText message={server.name} maxLength={60} />
            </CardTitle>
          </div>
          <div className="flex flex-wrap gap-1 items-center flex-shrink-0">
            {/* Version badge with dropdown */}
            {displayedServer.server.version && (
              <DropdownMenu
                open={versionsDropdownOpen}
                onOpenChange={setVersionsDropdownOpen}
              >
                <DropdownMenuTrigger asChild>
                  <Badge
                    variant="secondary"
                    className="text-xs cursor-pointer hover:bg-secondary/80"
                  >
                    v{displayedServer.server.version}
                    <ChevronDown className="ml-1 h-3 w-3" />
                  </Badge>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {availableVersions.length === 0 && (
                    <div className="px-2 py-1 text-xs text-muted-foreground">
                      Loading versions...
                    </div>
                  )}
                  {availableVersions.map((versionServer) => (
                    <DropdownMenuItem
                      key={versionServer.server.version}
                      onClick={() => {
                        // Only update if selecting a different version
                        if (
                          versionServer.server.version !==
                          displayedServer.server.version
                        ) {
                          setSelectedVersion(
                            versionServer.server.version || "",
                          );
                        }
                      }}
                      className="flex items-center justify-between gap-2"
                    >
                      <span>v{versionServer.server.version}</span>
                      {versionServer._meta[
                        "io.modelcontextprotocol.registry/official"
                      ]?.isLatest && (
                        <Badge
                          variant="default"
                          className="text-xs bg-green-600 hover:bg-green-700"
                        >
                          Latest
                        </Badge>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {/* Status badges */}
            {displayedServer._meta["io.modelcontextprotocol.registry/official"]
              ?.status === "deprecated" && (
              <Badge
                variant="outline"
                className="text-xs border-orange-500 text-orange-600"
              >
                Deprecated
              </Badge>
            )}
            {displayedServer._meta["io.modelcontextprotocol.registry/official"]
              ?.status === "deleted" && (
              <Badge
                variant="outline"
                className="text-xs border-red-500 text-red-600"
              >
                Deleted
              </Badge>
            )}
          </div>
        </div>

        <TransportBadges server={displayedServer} />

        {displayedServer.server.title && (
          <p className="text-sm text-muted-foreground mt-2">
            {displayedServer.server.title}
          </p>
        )}
      </CardHeader>
      <CardContent className="flex-1 flex flex-col space-y-3">
        {displayedServer.server.description && (
          <p className="text-sm text-muted-foreground line-clamp-3">
            {displayedServer.server.description}
          </p>
        )}

        <div className="flex flex-col gap-2 mt-auto pt-3">
          <div className="flex flex-wrap gap-2">
            {displayedServer.server.repository?.url && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenReadme(displayedServer)}
                  className="flex-1"
                >
                  <Info className="h-4 w-4 mr-1" />
                  Details
                </Button>
                <Button variant="outline" size="sm" asChild className="flex-1">
                  <a
                    href={displayedServer.server.repository.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Github className="h-4 w-4 mr-1" />
                    Code
                  </a>
                </Button>
              </>
            )}
            {displayedServer.server.websiteUrl && (
              <Button variant="outline" size="sm" asChild className="flex-1">
                <a
                  href={displayedServer.server.websiteUrl}
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
            onClick={() => onAddToCatalog(displayedServer)}
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

export default function McpCatalogPage({
  catalogItems: initialCatalogItems,
}: {
  catalogItems?: GetMcpCatalogResponses["200"];
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [readmeServer, setReadmeServer] = useState<ServerResponse | null>(null);

  // Get catalog items for filtering (with live updates)
  const { data: catalogItems } = useMcpCatalog({
    initialData: initialCatalogItems,
  });

  // Use server-side search
  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useMcpRegistryServersInfinite(searchQuery);

  // Mutation for adding servers to catalog
  const createMutation = useCreateMcpCatalogItem();

  const handleAddToCatalog = async (serverResponse: ServerResponse) => {
    await createMutation.mutateAsync({
      name: serverResponse.server.name,
      version: serverResponse.server.version,
    });
  };

  // Flatten all pages into a single array of servers
  const servers = useMemo(() => {
    if (!data) return [];
    return data.pages.flatMap((page) => page.servers || []);
  }, [data]);

  // Create a Set of catalog item names for efficient lookup
  const catalogServerNames = useMemo(
    () => new Set(catalogItems?.map((item) => item.name) || []),
    [catalogItems],
  );

  // Use all servers (don't filter out those already in catalog)
  const displayedServers = servers || [];

  return (
    <div className="w-full h-full">
      <div className="">
        <h1 className="text-lg font-semibold tracking-tight mb-2">
          External MCP Registry
        </h1>
        <p className="text-sm text-muted-foreground">
          Browse and discover Model Context Protocol (MCP) servers from the
          official registry.
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
              Failed to load servers from the MCP Registry
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
                  {displayedServers.map((serverResponse, index) => (
                    <ServerCard
                      key={`${serverResponse.server.name}-${index}`}
                      serverResponse={serverResponse}
                      onAddToCatalog={handleAddToCatalog}
                      isAdding={createMutation.isPending}
                      onOpenReadme={setReadmeServer}
                      isInCatalog={catalogServerNames.has(
                        serverResponse.server.name,
                      )}
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
