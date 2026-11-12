"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Info, Laptop, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { uninstallCommand } from "@/lib/mcp/mcp-bridge-command";
import { formatDate } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import {
  devicePlatformLabel,
  deviceProgramUpdateNotice,
  deviceProgramVersionLabel,
  deviceStatusLabel,
} from "./device-labels";

/**
 * The user's device: the computer that runs the MCP bridge, with whether it is
 * online. A user has one device; the table is ready for more.
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
            {`Set up the MCP bridge so ${appName} can use MCP servers running on your device.`}
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
        <div className="flex min-w-0 items-center gap-2">
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
      id: "added",
      header: "Added",
      size: 150,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {formatDate({
            date: row.original.createdAt,
            dateFormat: "MMM d, yyyy",
          })}
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
          fixedWidthColumnIds={["status", "platform", "version", "added"]}
          flexibleColumnIds={["name"]}
          // A phone keeps the name, whether it is online, and Unlink.
          columnDropOrder={["version", "added", "platform"]}
        />
      </div>
      <DeleteConfirmDialog
        open={deviceToRemove !== null}
        onOpenChange={(open) => {
          if (!open) setDeviceToRemove(null);
        }}
        title="Unlink device"
        description={`"${deviceToRemove?.name ?? ""}" will be unlinked from your account. ${appName} will no longer be able to use the MCP servers running on it. To also remove the MCP bridge from that device, run ${uninstallCommand(deviceToRemove?.platform === "windows")} there.`}
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
