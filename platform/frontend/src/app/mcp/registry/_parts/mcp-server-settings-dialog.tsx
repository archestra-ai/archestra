"use client";

import { E2eTestId, type McpDeploymentStatusEntry } from "@shared";
import { AlertCircle, PlugZap, RefreshCw, XIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogForm,
  DialogHeader,
  DialogStickyFooter,
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
  onAddOrgConnection?: () => void;
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
  connections: "Credentials",
  "debug-logs": "Logs",
  "debug-inspector": "Inspector",
  "debug-shell": "Shell",
  yaml: "K8s Deployment YAML",
};

function SidebarIcon({
  icon,
  catalogId,
}: {
  icon?: string | null;
  catalogId?: string;
}) {
  return <McpCatalogIcon icon={icon} catalogId={catalogId} size={28} />;
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
  onAddOrgConnection,
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
      label: "Credentials",
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
    navItems.push({ id: "yaml", label: "K8s Deployment YAML" });
  }

  const defaultPage = initialPage ?? navItems[0]?.id ?? "configuration";
  const [activePage, setActivePage] = useState<SettingsPage>(defaultPage);
  const [clickedServerId, setClickedServerId] = useState<string | null>(null);

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
            <div className="flex min-h-[72px] items-center border-b px-4 py-4">
              <div className="flex min-w-0 items-center gap-2.5">
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
                  data-testid={
                    navItem.id === "connections"
                      ? E2eTestId.McpServerSettingsConnectionsNavButton
                      : undefined
                  }
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
                  Install
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
            <div className="flex min-h-[72px] shrink-0 items-center justify-between border-b px-4 py-4">
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
                  ? "overflow-hidden px-4 pt-4 pb-4"
                  : "overflow-hidden p-0",
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
                  onAddOrgConnection={onAddOrgConnection}
                  deploymentStatuses={deploymentStatuses}
                  hideHeader
                  onOpenPodLogs={
                    showDebug
                      ? (podServerId: string) => {
                          setClickedServerId(podServerId);
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
                      installs={
                        item.multitenant
                          ? // Multi-tenant catalogs alias one pod; pick the
                            // install whose deployment status is reported,
                            // otherwise the first row, and label by catalog.
                            (() => {
                              const reporting =
                                installs.find(
                                  (i) => deploymentStatuses[i.id]?.podName,
                                ) ?? installs[0];
                              return [
                                {
                                  ...reporting,
                                  name: item.label || item.name,
                                  ownerEmail: null,
                                  teamDetails: null,
                                  scope: null,
                                },
                              ];
                            })()
                          : installs
                      }
                      deploymentStatuses={deploymentStatuses}
                      hideHeader
                      hideTabBar
                      controlledTab={DEBUG_TAB_MAP[validPage]}
                      onReinstall={() => onReinstall()}
                      initialServerId={clickedServerId ?? logsInitialServerId}
                    />
                  </div>
                ) : (
                  <Empty className="justify-start pt-16">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <PlugZap />
                      </EmptyMedia>
                      <EmptyDescription>
                        Install this server to open the{" "}
                        {PAGE_TITLES[validPage].toLowerCase()}.
                      </EmptyDescription>
                    </EmptyHeader>
                    {onConnect && (
                      <EmptyContent className="flex-row justify-center">
                        <Button onClick={() => onConnect()}>Install</Button>
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

      <Dialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
      >
        <DialogContent className="max-w-md flex flex-col overflow-hidden">
          <DialogHeader className="border-b-0">
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-500" />
              Unsaved changes
            </DialogTitle>
            <DialogDescription>
              You have unsaved configuration changes. What would you like to do?
            </DialogDescription>
          </DialogHeader>
          <DialogForm
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => e.preventDefault()}
          >
            <DialogStickyFooter className="mt-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => setPendingAction(null)}
              >
                Go back
              </Button>
              <Button
                type="button"
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
              <Button
                type="button"
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
              </Button>
            </DialogStickyFooter>
          </DialogForm>
        </DialogContent>
      </Dialog>
    </>
  );
}
