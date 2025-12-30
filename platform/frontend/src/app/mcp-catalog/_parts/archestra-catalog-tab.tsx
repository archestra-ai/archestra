"use client";

import {
  type archestraApiTypes,
  type archestraCatalogTypes,
  E2eTestId,
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
import { useHasPermissions } from "@/lib/auth.query";
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
import { parseDockerArgsToLocalConfig } from "./docker-args-parser";
import { RequestInstallationDialog } from "./request-installation-dialog";
import { TransportBadges } from "./transport-badges";

type ServerType = "all" | "remote" | "local";

export function ArchestraCatalogTab({
  catalogItems: initialCatalogItems,
  onClose,
  onSuccess,
}: {
  catalogItems?: archestraApiTypes.GetInternalMcpCatalogResponses["200"];
  onClose: () => void;
  onSuccess?: () => void;
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
    type: "all",
    category: "all",
  });

  // Get catalog items for filtering (with live updates)
  const { data: catalogItems } = useInternalMcpCatalog({
    initialData: initialCatalogItems,
  });

  // Fetch available categories
  const { data: availableCategories = [] } = useMcpServerCategories();

  const { data: userIsMcpServerAdmin = false } = useHasPermissions({
    mcpServer: ["admin"],
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

  const handleAddToCatalog = async (
    server: archestraCatalogTypes.ArchestraMcpServerManifest,
  ) => {
    const getValue = (
      config: NonNullable<
        archestraCatalogTypes.ArchestraMcpServerManifest["user_config"]
      >[string],
    ) => {
      if (config.type === "boolean") {
        return typeof config.default === "boolean"
          ? String(config.default)
          : "false";
      }
      if (config.type === "number" && typeof config.default === "number") {
        return String(config.default);
      }
      return undefined;
    };

    // For local servers, construct environment from server.env and user_config
    if (server.server.type === "local") {
      // Track which user_config keys are referenced in server.env
      const referencedUserConfigKeys = new Set<string>();

      const getEnvVarType = (
        userConfigEntry: NonNullable<
          archestraCatalogTypes.ArchestraMcpServerManifest["user_config"]
        >[string],
      ) => {
        if (userConfigEntry.sensitive) return "secret" as const;
        if (userConfigEntry.type === "boolean") return "boolean" as const;
        if (userConfigEntry.type === "number") return "number" as const;
        return "plain_text" as const;
      };

      // First pass: Parse server.env entries
      const envFromServerEnv = server.server.env
        ? Object.entries(server.server.env).map(([envKey, envValue]) => {
            // Check if value is ${user_config.xxx} placeholder
            const match = envValue.match(/^\$\{user_config\.(.+)\}$/);

            if (match && server.user_config) {
              const userConfigKey = match[1];
              const userConfigEntry = server.user_config[userConfigKey];
              referencedUserConfigKeys.add(userConfigKey);

              if (userConfigEntry) {
                return {
                  key: envKey, // Use env var name (e.g., CONFLUENCE_URL)
                  type: getEnvVarType(userConfigEntry),
                  value: "", // Empty - will be prompted
                  promptOnInstallation: true,
                  required: userConfigEntry.required ?? false,
                  description: [
                    userConfigEntry.title,
                    userConfigEntry.description,
                  ]
                    .filter(Boolean)
                    .join(": "),
                  default: Array.isArray(userConfigEntry.default)
                    ? undefined
                    : userConfigEntry.default,
                };
              }
            }

            // Static env var (no user_config reference)
            return {
              key: envKey,
              type: "plain_text" as const,
              value: envValue,
              promptOnInstallation: false,
              required: false,
              description: "",
              default: undefined,
            };
          })
        : [];

      // Second pass: Add user_config entries NOT referenced in server.env
      const envFromUnreferencedUserConfig = server.user_config
        ? Object.entries(server.user_config)
            .filter(([key]) => !referencedUserConfigKeys.has(key))
            .map(([key, config]) => ({
              key,
              type: getEnvVarType(config),
              value: getValue(config),
              promptOnInstallation: true,
              required: config.required ?? false,
              description: [config.title, config.description]
                .filter(Boolean)
                .join(": "),
              default: Array.isArray(config.default)
                ? undefined
                : config.default,
            }))
        : [];

      const environment = [
        ...envFromServerEnv,
        ...envFromUnreferencedUserConfig,
      ];
      await addServerToCatalog(server, environment);
      return;
    }

    // For remote servers, proceed with direct addition
    await addServerToCatalog(server, undefined);
  };

  const addServerToCatalog = async (
    server: archestraCatalogTypes.ArchestraMcpServerManifest,
    environment?: Array<{
      key: string;
      type: "plain_text" | "secret" | "boolean" | "number";
      value?: string;
      promptOnInstallation: boolean;
      required?: boolean;
      description?: string;
      default?: string | number | boolean;
    }>,
  ) => {
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

    let localConfig:
      | archestraApiTypes.CreateInternalMcpCatalogItemData["body"]["localConfig"]
      | undefined;
    if (server.server.type === "local") {
      const dockerConfig = parseDockerArgsToLocalConfig(
        server.server.command,
        server.server.args,
        server.server.docker_image,
      );
      if (dockerConfig) {
        const serviceAccount = (
          server.server as typeof server.server & { service_account?: string }
        ).service_account;
        localConfig = {
          command: dockerConfig.command,
          arguments: dockerConfig.arguments,
          dockerImage: dockerConfig.dockerImage,
          serviceAccount: serviceAccount
            ? serviceAccount.replace(
                /\{\{ARCHESTRA_RELEASE_NAME\}\}/g,
                "{{HELM_RELEASE_NAME}}",
              )
            : undefined,
          environment:
            environment ||
            (server.server.env
              ? Object.entries(server.server.env).map(([key, value]) => ({
                  key,
                  type: "plain_text" as const,
                  value,
                  promptOnInstallation: false,
                }))
              : undefined),
        };
      } else {
        const serviceAccount = (
          server.server as typeof server.server & { service_account?: string }
        ).service_account;
        localConfig = {
          command: server.server.command,
          arguments: server.server.args,
          serviceAccount: serviceAccount
            ? serviceAccount.replace(
                /\{\{ARCHESTRA_RELEASE_NAME\}\}/g,
                "{{HELM_RELEASE_NAME}}",
              )
            : undefined,
          environment:
            environment ||
            (server.server.env
              ? Object.entries(server.server.env).map(([key, value]) => ({
                  key,
                  type: "plain_text" as const,
                  value,
                  promptOnInstallation: false,
                }))
              : undefined),
        };
      }
    }

    await createMutation.mutateAsync({
      name: server.name,
      version: undefined, // No version in archestra catalog
      instructions: server.instructions,
      serverType: server.server.type,
      serverUrl:
        server.server.type === "remote" ? server.server.url : undefined,
      docsUrl:
        server.server.type === "remote"
          ? (server.server.docs_url ?? undefined)
          : undefined,
      localConfig,
      userConfig: server.user_config,
      oauthConfig: rewrittenOauth,
    });

    // Close the dialog after adding
    onClose();
    onSuccess?.();
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
              <div className="grid gap-4 md:grid-cols-2 overflow-y-auto pr-2">
                {filteredServers.map((server, index) => (
                  <ServerCard
                    key={`${server.name}-${index}`}
                    server={server}
                    onAddToCatalog={handleAddToCatalog}
                    onRequestInstallation={handleRequestInstallation}
                    isAdding={createMutation.isPending}
                    onOpenReadme={setReadmeServer}
                    isInCatalog={catalogServerNames.has(server.name)}
                    userIsMcpServerAdmin={userIsMcpServerAdmin}
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
  userIsMcpServerAdmin,
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
  userIsMcpServerAdmin: boolean;
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
              userIsMcpServerAdmin
                ? onAddToCatalog(server)
                : onRequestInstallation(server)
            }
            disabled={isAdding || isInCatalog}
            size="sm"
            className="w-full"
            data-testid={E2eTestId.AddCatalogItemButton}
          >
            {isInCatalog
              ? "Added"
              : userIsMcpServerAdmin
                ? "Add to Your Registry"
                : "Request to add to internal registry"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
