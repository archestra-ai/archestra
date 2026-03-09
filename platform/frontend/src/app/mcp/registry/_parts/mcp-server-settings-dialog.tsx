"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  type McpDeploymentStatusEntry,
} from "@shared";
import { AlertCircle, PlugZap, RefreshCw, Server, XIcon } from "lucide-react";
import Image from "next/image";
import { useCallback, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import { cn } from "@/lib/utils";
import {
  computeDeploymentStatusSummary,
  DeploymentStatusDot,
  getDeploymentLabel,
} from "./deployment-status";
import { EditCatalogContent } from "./edit-catalog-dialog";
import { ManageUsersContent } from "./manage-users-dialog";
import { McpLogsContent, type McpLogsTab } from "./mcp-logs-dialog";
import type { CatalogItemWithOptionalLabel } from "./mcp-server-card";
import { YamlConfigContent } from "./yaml-config-dialog";

type SettingsPage =
  | "configuration"
  | "connections"
  | "debug-logs"
  | "debug-inspector"
  | "debug-shell"
  | "yaml";

interface NavItemDef {
  id: SettingsPage;
  label: string;
  badge?: number;
}

interface McpServerSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPage?: SettingsPage;
  item: CatalogItemWithOptionalLabel;
  variant: "remote" | "local" | "builtin";
  showConnections: boolean;
  connectionCount?: number;
  showDebug: boolean;
  showInspector: boolean;
  showYaml: boolean;
  // Connections
  onAddPersonalConnection?: () => void;
  onAddSharedConnection?: (teamId: string) => void;
  // Debug
  installs: {
    id: string;
    name: string;
    ownerEmail?: string | null;
    teamDetails?: { teamId: string; name: string } | null;
  }[];
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>;
  deploymentServerIds: string[];
  onReinstall: () => void | Promise<void>;
  logsInitialServerId?: string | null;
  // Connect
  hasPersonalConnection?: boolean;
  onConnect?: () => void;
  // Reinstall
  needsReinstall?: boolean;
  // Delete
  onDelete?: () => void;
}

export type { SettingsPage };

const DEBUG_TAB_MAP: Record<string, McpLogsTab> = {
  "debug-logs": "logs",
  "debug-inspector": "inspector",
  "debug-shell": "debug",
};

const PAGE_TITLES: Record<SettingsPage, string> = {
  configuration: "Configuration",
  connections: "Connections",
  "debug-logs": "Logs",
  "debug-inspector": "Inspector",
  "debug-shell": "Shell",
  yaml: "K8s deployment YAML",
};

function SidebarIcon({
  icon,
  catalogId,
}: {
  icon?: string | null;
  catalogId?: string;
}) {
  const size = 28;
  if (!icon && catalogId === ARCHESTRA_MCP_CATALOG_ID) {
    return (
      <Image
        src="/logo.png"
        alt="Archestra"
        width={size}
        height={size}
        className="shrink-0 rounded-sm object-contain"
      />
    );
  }
  if (!icon) {
    return (
      <Server
        className="shrink-0 text-muted-foreground"
        style={{ width: size, height: size }}
      />
    );
  }
  if (icon.startsWith("data:")) {
    return (
      <Image
        src={icon}
        alt="MCP server icon"
        width={size}
        height={size}
        className="shrink-0 rounded-sm object-contain"
      />
    );
  }
  return (
    <span className="shrink-0 leading-none" style={{ fontSize: size }}>
      {icon}
    </span>
  );
}

export function McpServerSettingsDialog({
  open,
  onOpenChange,
  initialPage,
  item,
  variant,
  showConnections,
  connectionCount,
  showDebug,
  showInspector,
  showYaml,
  onAddPersonalConnection,
  onAddSharedConnection,
  installs,
  deploymentStatuses,
  deploymentServerIds,
  onReinstall,
  logsInitialServerId,
  hasPersonalConnection,
  onConnect,
  needsReinstall,
  onDelete,
}: McpServerSettingsDialogProps) {
  const isBuiltin = variant === "builtin";

  const navItems: NavItemDef[] = [];
  if (!isBuiltin) {
    navItems.push({ id: "configuration", label: "Configuration" });
  }
  if (showConnections) {
    navItems.push({
      id: "connections",
      label: "Connections",
      badge: connectionCount,
    });
  }
  if (showDebug) {
    navItems.push({ id: "debug-logs", label: "Logs" });
    navItems.push({ id: "debug-inspector", label: "Inspector" });
    navItems.push({ id: "debug-shell", label: "Shell" });
  } else if (showInspector) {
    navItems.push({ id: "debug-inspector", label: "Inspector" });
  }
  if (showYaml) {
    navItems.push({ id: "yaml", label: "K8s YAML" });
  }

  const defaultPage = initialPage ?? navItems[0]?.id ?? "configuration";
  const [activePage, setActivePage] = useState<SettingsPage>(defaultPage);

  // Reset to initial page when dialog opens with a specific page
  const [lastInitialPage, setLastInitialPage] = useState(initialPage);
  if (initialPage !== lastInitialPage) {
    setLastInitialPage(initialPage);
    if (initialPage) {
      setActivePage(initialPage);
    }
  }

  // Ensure active page is valid
  const validPage = navItems.some((n) => n.id === activePage)
    ? activePage
    : (navItems[0]?.id ?? "configuration");

  const isDebugPage = validPage.startsWith("debug-");

  // Configuration dirty state tracking
  const [isConfigDirty, setIsConfigDirty] = useState(false);
  const configSubmitRef = useRef<(() => Promise<void>) | null>(null);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const guardDirty = useCallback(
    (action: () => void) => {
      if (isConfigDirty && validPage === "configuration") {
        setPendingAction(() => action);
      } else {
        action();
      }
    },
    [isConfigDirty, validPage],
  );

  const navigateTo = useCallback(
    (target: SettingsPage) => {
      guardDirty(() => setActivePage(target));
    },
    [guardDirty],
  );

  const handleClose = () => onOpenChange(false);

  // Deployment summary for sidebar header
  const summary = computeDeploymentStatusSummary(
    deploymentServerIds,
    deploymentStatuses,
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="max-w-6xl h-[85vh] flex flex-row p-0 gap-0 overflow-hidden"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">
            {item.label || item.name} Settings
          </DialogTitle>
          <DialogDescription className="sr-only">
            Server settings and configuration
          </DialogDescription>
          {/* Sidebar */}
          <nav className="w-[220px] border-r flex flex-col shrink-0">
            {/* Server header */}
            <div className="p-4 pb-3 border-b">
              <div className="flex items-center gap-2.5">
                <SidebarIcon icon={item.icon} catalogId={item.id} />
                <div className="min-w-0 flex-1">
                  <TruncatedTooltip content={item.label || item.name}>
                    <div className="font-semibold text-sm truncate">
                      {item.label || item.name}
                    </div>
                  </TruncatedTooltip>
                  {summary && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                      <DeploymentStatusDot state={summary.overallState} />
                      <span>
                        {summary.running}{" "}
                        {getDeploymentLabel(summary.overallState).toLowerCase()}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Nav items */}
            <div className="flex flex-col gap-0.5 px-2 py-3 flex-1">
              {navItems.map((navItem) => (
                <Button
                  key={navItem.id}
                  variant="ghost"
                  className={cn(
                    "justify-start h-9 px-3 font-normal w-full",
                    validPage === navItem.id &&
                      "bg-accent text-accent-foreground font-medium",
                  )}
                  onClick={() => navigateTo(navItem.id)}
                >
                  {navItem.label}
                  {navItem.badge != null && navItem.badge > 0 && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      {navItem.badge}
                    </span>
                  )}
                </Button>
              ))}
            </div>

            {/* Footer actions */}
            <div className="px-2 pb-3 flex flex-col gap-1.5">
              {!hasPersonalConnection && onConnect && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-start"
                  onClick={() =>
                    guardDirty(() => {
                      onConnect();
                    })
                  }
                >
                  {variant === "remote" ? "Connect" : "Install"}
                </Button>
              )}
              {needsReinstall && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-start gap-2"
                  onClick={() => onReinstall()}
                >
                  <RefreshCw className="h-4 w-4" />
                  Reinstall
                </Button>
              )}
              {onDelete && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start gap-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => {
                    handleClose();
                    onDelete();
                  }}
                >
                  Delete
                </Button>
              )}
            </div>
          </nav>

          {/* Content */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {/* Content header */}
            <div className="flex items-center justify-between px-6 py-4 shrink-0">
              <h2 className="text-lg font-semibold">
                {PAGE_TITLES[validPage]}
              </h2>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-xs opacity-70 hover:opacity-100"
                onClick={handleClose}
              >
                <XIcon className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </Button>
            </div>

            {/* Content body */}
            <div
              className={cn(
                "flex-1 flex flex-col min-h-0",
                isDebugPage
                  ? "overflow-hidden px-6 pb-6"
                  : "overflow-y-auto p-6",
              )}
            >
              {validPage === "configuration" && !isBuiltin && (
                <EditCatalogContent
                  item={item}
                  onClose={handleClose}
                  keepOpenOnSave
                  onDirtyChange={setIsConfigDirty}
                  submitRef={configSubmitRef}
                />
              )}

              {validPage === "connections" && showConnections && (
                <ManageUsersContent
                  isActive={open && validPage === "connections"}
                  onClose={handleClose}
                  label={item.label || item.name}
                  catalogId={item.id}
                  onAddPersonalConnection={onAddPersonalConnection}
                  onAddSharedConnection={onAddSharedConnection}
                  deploymentStatuses={deploymentStatuses}
                  hideHeader
                  variant={variant}
                  onOpenPodLogs={
                    showDebug
                      ? () => {
                          setActivePage("debug-logs");
                        }
                      : undefined
                  }
                />
              )}

              {isDebugPage &&
                (showDebug || showInspector) &&
                (installs.length > 0 ? (
                  <div className="flex flex-col flex-1 min-h-0">
                    <McpLogsContent
                      isActive={open && isDebugPage}
                      serverName={item.label || item.name}
                      installs={installs}
                      deploymentStatuses={deploymentStatuses}
                      hideHeader
                      hideTabBar
                      controlledTab={DEBUG_TAB_MAP[validPage]}
                      onReinstall={() => onReinstall()}
                      initialServerId={logsInitialServerId}
                    />
                  </div>
                ) : (
                  <Empty className="justify-start pt-16">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <PlugZap />
                      </EmptyMedia>
                      <EmptyDescription>
                        {variant === "remote" ? "Connect" : "Install"} this
                        server to open the{" "}
                        {PAGE_TITLES[validPage].toLowerCase()}.
                      </EmptyDescription>
                    </EmptyHeader>
                    {onConnect && (
                      <EmptyContent className="flex-row justify-center">
                        <Button onClick={() => onConnect()}>
                          {variant === "remote" ? "Connect" : "Install"}
                        </Button>
                      </EmptyContent>
                    )}
                  </Empty>
                ))}

              {validPage === "yaml" && showYaml && (
                <YamlConfigContent
                  item={item}
                  onClose={handleClose}
                  hideHeader
                />
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-500" />
              Unsaved changes
            </AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved configuration changes. What would you like to do?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Go back</AlertDialogCancel>
            <Button
              variant="outline"
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => {
                pendingAction?.();
                setIsConfigDirty(false);
                setPendingAction(null);
              }}
            >
              Discard
            </Button>
            <AlertDialogAction
              onClick={async () => {
                if (configSubmitRef.current) {
                  await configSubmitRef.current();
                }
                pendingAction?.();
                setIsConfigDirty(false);
                setPendingAction(null);
              }}
            >
              Save first
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
