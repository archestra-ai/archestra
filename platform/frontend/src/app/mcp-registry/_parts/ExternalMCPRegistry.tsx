"use client";

import {
  BookOpen,
  FileText,
  Github,
  Loader2,
  Plus,
  Search,
  Tag,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DebouncedInput } from "@/components/debounced-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { GetMcpCatalogResponses } from "@/lib/clients/api";
import type { ServerResponse } from "@/lib/clients/mcp-registry";
import {
  useCreateMcpCatalogItem,
  useMcpCatalog,
} from "@/lib/mcp-catalog.query";
import { useMcpRegistryServersInfinite } from "@/lib/mcp-registry-external.query";
import { ReadmeDialog } from "./readme-dialog";

export default function McpCatalogPage({
  catalogItems: initialCatalogItems,
}: {
  catalogItems?: GetMcpCatalogResponses["200"];
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
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
    try {
      await createMutation.mutateAsync({ name: serverResponse.server.name });
      toast.success(
        `Added "${serverResponse.server.name}" to your MCP servers`,
      );
    } catch (error) {
      toast.error(`Failed to add "${serverResponse.server.name}"`);
      console.error("Add to catalog error:", error);
    }
  };

  // Flatten all pages into a single array of servers
  const servers = useMemo(() => {
    if (!data) return [];
    return data.pages.flatMap((page) => page.servers || []);
  }, [data]);

  // Apply client-side category filtering (search is server-side)
  const filteredServers = useMemo(() => {
    if (!servers) return [];

    // Create a Set of catalog item names for efficient lookup
    const catalogServerNames = new Set(
      catalogItems?.map((item) => item.name) || [],
    );

    // Filter out servers already in catalog
    const filtered = servers.filter(
      (serverResponse) => !catalogServerNames.has(serverResponse.server.name),
    );

    // Filter by category (client-side only) - categories not currently provided by API
    // if (selectedCategory) {
    //   filtered = filtered.filter((serverResponse) =>
    //     serverResponse.server.categories?.includes(selectedCategory),
    //   );
    // }

    return filtered;
  }, [servers, catalogItems]);

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
            placeholder="Search servers by name, description, author, or tags..."
            initialValue={searchQuery}
            onChange={setSearchQuery}
            className="pl-9"
          />
        </div>

        {/* Category Filters - Hidden for now as the API doesn't provide categories yet */}
        {SHOW_CATEGORIES && (
          <div className="space-y-2">
            <h2 className="text-sm font-medium flex items-center gap-2">
              <Tag className="h-4 w-4" />
              Categories (JUST MOCK - REVERT IF NOT NEEDED)
            </h2>
            <div className="flex flex-wrap gap-2">
              <Badge
                variant={selectedCategory === null ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => setSelectedCategory(null)}
              >
                All
              </Badge>
              {CATEGORIES_MOCK.map((category) => (
                <Badge
                  key={category}
                  variant={
                    selectedCategory === category ? "default" : "outline"
                  }
                  className="cursor-pointer"
                  onClick={() => setSelectedCategory(category)}
                >
                  {category}
                </Badge>
              ))}
            </div>
          </div>
        )}

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
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {filteredServers.map((serverResponse, index) => {
                    const server = serverResponse.server;
                    const uniqueKey = `${server.name}-${server.version}-${index}`;

                    return (
                      <Card key={uniqueKey} className="flex flex-col">
                        <CardHeader>
                          <CardTitle className="text-lg">
                            {server.name}
                          </CardTitle>
                          {server.title && (
                            <p className="text-sm text-muted-foreground">
                              {server.title}
                            </p>
                          )}
                        </CardHeader>
                        <CardContent className="flex-1 flex flex-col space-y-3">
                          {server.description && (
                            <p className="text-sm text-muted-foreground line-clamp-3">
                              {server.description}
                            </p>
                          )}

                          <div className="flex flex-col gap-2 mt-auto pt-3">
                            <div className="flex flex-wrap gap-2">
                              {server.repository?.url && (
                                <>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                      setReadmeServer(serverResponse)
                                    }
                                    className="flex-1"
                                  >
                                    <FileText className="h-4 w-4 mr-1" />
                                    README
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    asChild
                                    className="flex-1"
                                  >
                                    <a
                                      href={server.repository.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                    >
                                      <Github className="h-4 w-4 mr-1" />
                                      Code
                                    </a>
                                  </Button>
                                </>
                              )}
                              {server.websiteUrl && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  asChild
                                  className="flex-1"
                                >
                                  <a
                                    href={server.websiteUrl}
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
                              onClick={() => handleAddToCatalog(serverResponse)}
                              disabled={createMutation.isPending}
                              size="sm"
                              className="w-full"
                            >
                              <Plus className="h-4 w-4 mr-1" />
                              {createMutation.isPending ? "Adding..." : "Add"}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
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
        <ReadmeDialog
          server={readmeServer}
          onClose={() => setReadmeServer(null)}
        />
      </div>
    </div>
  );
}

const CATEGORIES_MOCK = [
  "AI Tools",
  "Development",
  "Finance",
  "Security",
  "Data",
  "Monitoring",
  "Browser Automation",
  "Cloud",
  "Search",
  "Aggregators",
  "Enterprise",
  "Knowledge",
  "Location",
  "Data Science",
  "CLI Tools",
  "File Management",
  "Social Media",
  "Travel",
  "Art & Culture",
  "Gaming",
  "Communication",
  "Healthcare",
  "Marketing",
  "Media",
  "Sports",
  "CRM",
  "IoT",
  "Job Search",
  "Messengers",
  "Audio",
  "Local files",
  "Support",
  "Translation",
  "Email",
  "Logistics",
  "Uncategorized",
];
const SHOW_CATEGORIES = true;
