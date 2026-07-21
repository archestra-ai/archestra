"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { Badge } from "@/components/ui/badge";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LOCAL_MCP_DISABLED_MESSAGE } from "@/consts";
import { useFeature } from "@/lib/config/config.query";
import type { CatalogItem, InstalledServer } from "./mcp-server-card";

// Table variant of the registry catalog list: a compact overview with the
// name linking to the item detail page (where the full card-level actions
// live) and an inline Install action for items without a connection yet.
export function McpServerTable({
  items,
  getServerInfo,
  envLabelByCatalog,
  installingItemId,
  onInstall,
}: {
  items: CatalogItem[];
  getServerInfo: (item: CatalogItem) => {
    installedServer?: InstalledServer;
    isInstallInProgress?: boolean;
  };
  envLabelByCatalog: Map<string, string | null>;
  installingItemId: string | null;
  onInstall: (item: CatalogItem) => void;
}) {
  const isLocalMcpEnabled = useFeature("orchestratorK8sRuntime");

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[26%]">Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="w-[12%] whitespace-nowrap">
              Environment
            </TableHead>
            <TableHead className="w-16">Tools</TableHead>
            <TableHead className="w-[14%]">Author</TableHead>
            <TableHead className="w-[14%] text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const { installedServer, isInstallInProgress } =
              getServerInfo(item);
            const isInstalling =
              installingItemId === item.id || !!isInstallInProgress;
            const environmentLabel = envLabelByCatalog.get(item.id);
            const installDisabledByRuntime =
              item.serverType === "local" && !isLocalMcpEnabled;
            return (
              <TableRow key={item.id}>
                <TableCell>
                  <Link
                    href={`/mcp/registry/${item.id}`}
                    className="flex min-w-0 items-center gap-2 hover:underline"
                  >
                    <McpCatalogIcon
                      icon={item.icon}
                      catalogId={item.id}
                      size={18}
                    />
                    <span className="min-w-0 truncate font-medium">
                      {item.name}
                    </span>
                  </Link>
                </TableCell>
                <TableCell>
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {item.description}
                  </span>
                </TableCell>
                <TableCell>
                  {environmentLabel ? (
                    <Badge
                      variant="outline"
                      className="max-w-full text-muted-foreground"
                    >
                      <span className="truncate">{environmentLabel}</span>
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="text-muted-foreground">
                    {item.toolCount ?? 0}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="line-clamp-1 text-muted-foreground">
                    {item.authorName ?? "—"}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  {isInstalling ? (
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Installing…
                    </span>
                  ) : item.serverType === "builtin" || installedServer ? (
                    <Badge variant="secondary">Installed</Badge>
                  ) : (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>
                            <PermissionButton
                              permissions={{
                                mcpServerInstallation: ["create"],
                              }}
                              onClick={() => onInstall(item)}
                              disabled={installDisabledByRuntime}
                              size="sm"
                              variant="outline"
                            >
                              Install
                            </PermissionButton>
                          </span>
                        </TooltipTrigger>
                        {installDisabledByRuntime && (
                          <TooltipContent side="bottom">
                            <p>{LOCAL_MCP_DISABLED_MESSAGE}</p>
                          </TooltipContent>
                        )}
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
