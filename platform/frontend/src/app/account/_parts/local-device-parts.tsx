"use client";

import { Info } from "lucide-react";
import Link from "next/link";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { cn } from "@/lib/utils/tailwind";
import type {
  LocalDevice,
  LocalDevicesController,
} from "./use-local-devices-controller";

/**
 * Building blocks shared by every Devices layout: the status dot, the
 * not-available states, and the revoke dialog.
 */

export function DeviceStatusDot({
  status,
  className,
}: {
  status: LocalDevice["status"];
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        status === "online" && "bg-emerald-500",
        status === "offline" && "bg-muted-foreground/40",
        status === "pending" && "bg-amber-500 motion-safe:animate-pulse",
        status === "revoked" && "bg-destructive",
        className,
      )}
    />
  );
}

/**
 * Loading, error and switched-off states. Returns null once the list is
 * ready, so a layout renders `<DevicesUnavailable /> ?? <its own list>`.
 */
export function DevicesUnavailable({
  controller,
  loading,
}: {
  controller: LocalDevicesController;
  /** Each layout draws its own skeleton. */
  loading: React.ReactNode;
}) {
  if (controller.availability === "loading") return <>{loading}</>;
  if (controller.availability === "error")
    return (
      <QueryLoadError
        className="py-6"
        title="Couldn't load your devices"
        error={controller.error}
        onRetry={controller.retry}
      />
    );
  if (controller.availability === "disabled")
    return (
      <InlineNotice variant="info">
        <Info />
        <span className="font-medium">Local devices are turned off</span>
        <InlineNoticeText>
          {controller.canManageOrg ? (
            <span>
              Turn on Local devices in MCP settings to let people connect their
              computers.
            </span>
          ) : (
            <span>
              Your organization hasn&apos;t turned on local devices. Ask an
              admin to turn on Local devices in MCP settings.
            </span>
          )}
        </InlineNoticeText>
        {controller.canManageOrg && (
          <Button asChild size="xs" variant="outline" className="ml-auto">
            <Link href="/settings/mcp">Open MCP settings</Link>
          </Button>
        )}
      </InlineNotice>
    );
  return null;
}

export function RevokeDeviceDialog({
  controller,
  device,
  onClose,
}: {
  controller: LocalDevicesController;
  device: LocalDevice | null;
  onClose: () => void;
}) {
  return (
    <DeleteConfirmDialog
      open={device !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`Revoke access for ${device?.name ?? "this device"}?`}
      description="The background agent on that computer is signed out and cannot reconnect. Run Connect on that computer to add it again."
      confirmLabel="Revoke access"
      pendingLabel="Revoking…"
      isPending={device !== null && controller.revokingId === device.id}
      onConfirm={async () => {
        if (!device) return;
        if (await controller.revoke(device.id)) onClose();
      }}
    />
  );
}
