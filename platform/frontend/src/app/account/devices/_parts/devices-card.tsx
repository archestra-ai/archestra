"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { ChevronRight, Info, Laptop, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CopyableCode } from "@/components/copyable-code";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { McpBridgeSetupDialog } from "@/components/mcp-bridge-setup";
import { QueryLoadError } from "@/components/query-load-error";
import { TableRowActions } from "@/components/table-row-actions";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import {
  type DesktopDevice,
  useDeleteDesktopDevice,
  useDesktopDevices,
} from "@/lib/desktop-device.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { desktopMcpServerHref } from "@/lib/mcp/desktop-mcp";
import {
  BRIDGE_START_COMMAND,
  BRIDGE_STATUS_COMMAND,
  UNINSTALL_COMMAND,
} from "@/lib/mcp/mcp-bridge-command";
import { cn } from "@/lib/utils/tailwind";
import {
  devicePlatformLabel,
  deviceProgramUpdateNotice,
  deviceProgramVersionLabel,
  deviceServerRows,
  deviceServersLabel,
  deviceStatusLabel,
} from "./device-labels";

/**
 * The user's device: the computer that runs the MCP bridge, with whether it is
 * online and how its MCP servers do. A user has one device; the table is
 * ready for more. A click on a row opens it: an online device lists its MCP
 * servers, with the error of each one that failed; an offline one says how
 * to check the MCP bridge on that device.
 *
 * The setup dialog lives beside the table, not in the empty state: the page
 * shows the table as soon as the device is linked, and the dialog stays open
 * to say so.
 */
export function DevicesCard() {
  const [setupOpen, setSetupOpen] = useState(false);
  return (
    <>
      <DevicesTable onSetUp={() => setSetupOpen(true)} />
      <McpBridgeSetupDialog open={setupOpen} onOpenChange={setSetupOpen} />
    </>
  );
}

function DevicesTable({ onSetUp }: { onSetUp: () => void }) {
  const appName = useAppName();
  const devices = useDesktopDevices();
  const deleteDevice = useDeleteDesktopDevice();
  const [deviceToRemove, setDeviceToRemove] = useState<DesktopDevice | null>(
    null,
  );

  if (devices.isLoadingError) {
    return (
      <QueryLoadError
        title="Your devices could not be loaded"
        error={devices.error}
        onRetry={() => devices.refetch()}
      />
    );
  }

  const rows = devices.data ?? [];
  if (!devices.isPending && rows.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Laptop />
          </EmptyMedia>
          <EmptyTitle>No device is linked</EmptyTitle>
          <EmptyDescription>
            {`Connect your device to ${appName}, so it can use MCP servers running there.`}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={onSetUp}>
            Set up the MCP bridge
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  const columns: ColumnDef<DesktopDevice>[] = [
    {
      id: "name",
      header: "Name",
      size: 170,
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-expanded={row.getIsExpanded()}
            aria-label={
              row.getIsExpanded()
                ? `Hide the details of ${row.original.name}`
                : `Show the details of ${row.original.name}`
            }
            onClick={(event) => {
              // The row opens on a click too: one toggle, not two.
              event.stopPropagation();
              row.toggleExpanded();
            }}
          >
            <ChevronRight
              className={cn(
                "transition-transform motion-reduce:transition-none",
                row.getIsExpanded() && "rotate-90",
              )}
            />
          </Button>
          <Laptop
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="truncate font-medium">{row.original.name}</span>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      size: 150,
      cell: ({ row }) => <DeviceStatus device={row.original} />,
    },
    {
      id: "servers",
      header: "MCP Servers",
      size: 170,
      cell: ({ row }) => <DeviceServers device={row.original} />,
    },
    {
      id: "platform",
      header: "Platform",
      size: 130,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {devicePlatformLabel(row.original.platform)}
        </span>
      ),
    },
    {
      id: "version",
      header: "Version",
      size: 120,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {deviceProgramVersionLabel(row.original.programVersion)}
        </span>
      ),
    },
    {
      id: "actions",
      size: 80,
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <TableRowActions
            itemName={row.original.name}
            actions={[
              {
                icon: <Trash2 className="size-4" />,
                label: "Unlink device",
                variant: "destructive",
                onClick: () => setDeviceToRemove(row.original),
              },
            ]}
          />
        </div>
      ),
    },
  ];

  // A user has one device, so at most one of them needs an update.
  const updateNotice =
    rows.map(deviceProgramUpdateNotice).find((notice) => notice !== null) ??
    null;

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        {updateNotice && (
          <InlineNotice variant="info">
            <Info />
            <InlineNoticeBody>
              <span className="font-medium">{updateNotice.title}</span>
              <InlineNoticeText>
                <span>{updateNotice.text.before}</span>
                <code className="font-mono">{updateNotice.text.command}</code>
                <span>{updateNotice.text.after}</span>
              </InlineNoticeText>
            </InlineNoticeBody>
          </InlineNotice>
        )}
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(device) => device.id}
          isLoading={devices.isPending}
          hidePaginationWhenSinglePage
          fixedWidthColumnIds={["status", "servers", "platform", "version"]}
          flexibleColumnIds={["name"]}
          // A phone keeps the name, whether it is online, and Unlink.
          columnDropOrder={["version", "platform", "servers"]}
          renderSubComponent={({ row }) => (
            <DeviceDetails device={row.original} />
          )}
          expandOnRowClick
        />
      </div>
      <DeleteConfirmDialog
        open={deviceToRemove !== null}
        onOpenChange={(open) => {
          if (!open) setDeviceToRemove(null);
        }}
        title="Unlink device"
        description={`"${deviceToRemove?.name ?? ""}" will be unlinked from your account. ${appName} will no longer be able to use the MCP servers running on it. To also remove the MCP bridge from that device, run ${UNINSTALL_COMMAND} there.`}
        isPending={deleteDevice.isPending}
        confirmLabel="Unlink"
        pendingLabel="Unlinking..."
        onConfirm={() => {
          if (!deviceToRemove) return;
          deleteDevice.mutate(deviceToRemove.id, {
            onSuccess: () => setDeviceToRemove(null),
          });
        }}
      />
    </div>
  );
}

function DeviceStatus({ device }: { device: DesktopDevice }) {
  const { status, lastOnline } = deviceStatusLabel(device);
  return (
    <span className="flex flex-col">
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 rounded-full",
            device.online ? "bg-emerald-500" : "bg-muted-foreground/50",
          )}
        />
        <span className={cn(!device.online && "text-muted-foreground")}>
          {status}
        </span>
      </span>
      {lastOnline && (
        <span className="text-xs text-muted-foreground">{lastOnline}</span>
      )}
    </span>
  );
}

/** The MCP Servers column; a dash while the device is offline. */
function DeviceServers({ device }: { device: DesktopDevice }) {
  const label = deviceServersLabel(device);
  if (!label) return <span className="text-muted-foreground">—</span>;
  return (
    <span>
      {label.running}
      {label.failed && (
        <>
          <span className="text-muted-foreground"> · </span>
          <span className="font-medium text-destructive">{label.failed}</span>
        </>
      )}
    </span>
  );
}

/**
 * The open row of a device. Each MCP server opens its page in the MCP
 * Registry, at the connections of that server.
 */
function DeviceDetails({ device }: { device: DesktopDevice }) {
  if (!device.online) {
    return (
      <div className="flex flex-col gap-2.5 py-3 pr-4 pl-14">
        <p className="text-muted-foreground">
          {`The MCP bridge on ${device.name} is not connected. Check it in a terminal on that device, and start it if it does not run.`}
        </p>
        <div className="flex flex-wrap gap-2">
          {[BRIDGE_STATUS_COMMAND, BRIDGE_START_COMMAND].map((command) => (
            <CopyableCode
              key={command}
              value={command}
              className="w-fit border bg-background py-1"
            />
          ))}
        </div>
      </div>
    );
  }

  const servers = deviceServerRows(device.servers);
  if (servers.length === 0) {
    return (
      <p className="py-3 pr-4 pl-14 text-muted-foreground">
        No MCP servers run on this device yet.
      </p>
    );
  }
  return (
    <ul className="divide-y pr-4 pb-1 pl-14">
      {servers.map((server) => (
        <li key={server.catalogId}>
          <Link
            href={desktopMcpServerHref(server.catalogId)}
            className="-mx-2 flex flex-col gap-1 rounded-md px-2 py-2.5 hover:bg-muted/50"
          >
            <div className="flex flex-wrap items-center gap-2.5">
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 rounded-full",
                  server.failed
                    ? "bg-destructive"
                    : server.running
                      ? "bg-emerald-500"
                      : "bg-muted-foreground/50",
                )}
              />
              <span className="font-medium">{server.name}</span>
              {server.state && (
                <span
                  className={
                    server.failed
                      ? "font-medium text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {server.state}
                </span>
              )}
            </div>
            {server.error && (
              <p className="ml-4 text-muted-foreground">{server.error}</p>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}
