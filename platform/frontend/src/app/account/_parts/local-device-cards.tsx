"use client";

import { Check, Monitor, MoreHorizontal, Plus, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { siApple } from "simple-icons";
import {
  DeviceStatusDot,
  DevicesUnavailable,
  RevokeDeviceDialog,
} from "@/app/account/_parts/local-device-parts";
import {
  DEVICE_NAME_MAX_LENGTH,
  type DevicePlatform,
  describeDevice,
  PLATFORM_LABELS,
  STATUS_LABELS,
} from "@/app/account/_parts/local-devices.utils";
import type {
  LocalDevice,
  LocalDevicesController,
} from "@/app/account/_parts/use-local-devices-controller";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";

export function LocalDeviceCards({
  controller,
}: {
  controller: LocalDevicesController;
}) {
  const [revoking, setRevoking] = useState<LocalDevice | null>(null);
  if (controller.availability !== "ready")
    return (
      <DevicesUnavailable controller={controller} loading={<ShelfSkeleton />} />
    );
  const shelf = controller.devices;

  return (
    <section aria-label="Your devices" className="w-full">
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shelf.map((device) => (
          <li key={device.id}>
            <DeviceTile
              device={device}
              busy={controller.revokingId === device.id}
              saving={controller.renamingId === device.id}
              onRename={(name) => controller.rename(device.id, name)}
              onRevoke={() => setRevoking(device)}
            />
          </li>
        ))}
        <li>
          <Link
            href="/connection"
            className="group flex h-full min-h-40 w-full flex-col items-start rounded-xl border border-dashed p-4 text-left transition-colors hover:border-foreground/30 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ShelfGlyph platform={null} screen="empty" />
            <span className="mt-3 text-sm font-medium">Add device</span>
            <span className="text-xs text-muted-foreground">
              Run Connect on the computer you want to add.
            </span>
          </Link>
        </li>
      </ul>

      <RevokeDeviceDialog
        controller={controller}
        device={revoking}
        onClose={() => setRevoking(null)}
      />
    </section>
  );
}

// === Tiles ===

function DeviceTile({
  device,
  busy,
  saving,
  onRename,
  onRevoke,
}: {
  device: LocalDevice;
  busy: boolean;
  saving: boolean;
  onRename: (name: string) => Promise<boolean>;
  onRevoke: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(device.name);
  const description = describeDevice(device);
  const beginRename = () => {
    setDraft(device.name);
    setEditing(true);
  };
  const seen =
    device.status === "online"
      ? "Active now"
      : device.lastSeenAt
        ? `Seen ${formatRelativeTimeFromNow(device.lastSeenAt, { strict: true })}`
        : "Never seen";

  return (
    <article
      aria-label={device.name}
      className={cn(
        "flex h-full flex-col rounded-xl border bg-card p-4 transition-[opacity,border-color,box-shadow] duration-500",
        busy && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <ShelfGlyph
          platform={device.platform}
          screen={
            device.status === "online"
              ? "online"
              : device.status === "offline"
                ? "offline"
                : "pending"
          }
        />
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="-mr-1 text-muted-foreground"
              aria-label={`Actions for ${device.name}`}
              disabled={busy || saving}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onSelect={onRevoke}>
              <Trash2 />
              <span>Revoke access</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {editing ? (
        <form
          className="mt-3 flex items-center gap-1"
          onSubmit={async (event) => {
            event.preventDefault();
            const name = draft.trim();
            if (!name) return;
            if (name === device.name || (await onRename(name)))
              setEditing(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !saving) {
              event.preventDefault();
              setEditing(false);
            }
          }}
        >
          <Input
            aria-label={`Device name for ${device.name}`}
            value={draft}
            maxLength={DEVICE_NAME_MAX_LENGTH}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => event.target.select()}
            disabled={saving}
            autoFocus
            className="h-8 min-w-0"
          />
          <Button
            type="submit"
            size="icon-xs"
            variant="ghost"
            aria-label="Save device name"
            disabled={!draft.trim() || saving}
          >
            <Check />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Cancel rename"
            disabled={saving}
            onClick={() => setEditing(false)}
          >
            <X />
          </Button>
        </form>
      ) : (
        <UnstyledButton
          className="mt-3 w-full truncate text-left text-sm font-medium hover:underline"
          aria-label={`Rename ${device.name}`}
          disabled={busy || saving}
          onClick={beginRename}
        >
          {device.name}
        </UnstyledButton>
      )}
      {description && (
        <p className="truncate text-xs text-muted-foreground">{description}</p>
      )}

      <div className="mt-auto flex min-w-0 items-center justify-between gap-3 pt-3 text-xs">
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <DeviceStatusDot status={device.status} className="size-1.5" />
          <span>{STATUS_LABELS[device.status]}</span>
        </span>
        <span
          className="truncate text-right text-muted-foreground"
          title={`${seen} · Added ${formatRelativeTimeFromNow(device.createdAt, { strict: true })}`}
        >
          {device.status === "offline" && device.lastSeenAt
            ? seen
            : `Added ${formatRelativeTimeFromNow(device.createdAt, { strict: true })}`}
        </span>
      </div>
    </article>
  );
}

function ShelfSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {[0, 1, 2].map((n) => (
        <Skeleton key={n} className="h-40 rounded-xl" />
      ))}
    </div>
  );
}

// === The glyph ===

type Screen = "empty" | "pending" | "online" | "offline";

/**
 * A small laptop (or a monitor for Windows). Dashed screen: nothing
 * connected yet; pulsing: waiting for the connector; solid with a check:
 * online right now; dimmed: offline.
 */
function ShelfGlyph({
  platform,
  screen,
}: {
  platform: DevicePlatform | null;
  screen: Screen;
}) {
  return (
    <div aria-hidden className="flex w-16 shrink-0 flex-col items-center">
      <div
        className={cn(
          "relative grid h-10 w-full place-items-center rounded-md border-[1.5px] transition-colors duration-500",
          screen === "empty" &&
            "border-dashed border-muted-foreground/35 text-muted-foreground/60",
          screen === "pending" &&
            "border-dashed border-primary/50 bg-background text-primary",
          screen === "online" &&
            "border-emerald-500/60 bg-background text-foreground",
          screen === "offline" &&
            "border-border bg-muted/40 text-muted-foreground/50",
        )}
      >
        {screen === "pending" && (
          <span className="absolute size-6 rounded-full bg-primary/15 motion-safe:animate-pulse" />
        )}
        {screen === "empty" ? (
          <Plus className="size-4" />
        ) : (
          <OsMark platform={platform} />
        )}
        {screen === "online" && (
          <span className="absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full bg-emerald-500 text-white shadow-sm motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-300">
            <Check className="size-2.5" strokeWidth={3.5} />
          </span>
        )}
      </div>
      {platform === "win32" ? (
        <>
          <div className="h-1.5 w-1.5 bg-border" />
          <div className="h-1 w-7 rounded-full bg-border" />
        </>
      ) : (
        <div className="h-1.5 w-[116%] rounded-b-md border border-t-0 bg-muted" />
      )}
    </div>
  );
}

const WINDOWS_PATH =
  "M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801";

function OsMark({ platform }: { platform: DevicePlatform | null }) {
  if (platform === null || platform === "linux")
    return <Monitor className="relative size-4" />;
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="relative size-4">
      <title>{PLATFORM_LABELS[platform]}</title>
      <path d={platform === "darwin" ? siApple.path : WINDOWS_PATH} />
    </svg>
  );
}
