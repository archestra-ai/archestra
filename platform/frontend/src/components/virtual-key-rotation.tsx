"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { CopyableCode } from "@/components/copyable-code";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { formatRelativeTime } from "@/lib/utils/date-time";
import { useRotateVirtualApiKey } from "@/lib/virtual-api-keys.query";

type RotatableVirtualKey = Pick<
  archestraApiTypes.GetAllVirtualApiKeysResponses["200"]["data"][number],
  "id" | "name"
>;
type RotatedVirtualKey = archestraApiTypes.RotateVirtualApiKeyResponses["200"];

/**
 * Rotate a key now: pick how long the current value keeps working, then show
 * the new value once (to the key's creator; anyone else is told where the
 * creator finds it).
 */
export function RotateVirtualKeyDialog({
  virtualKey,
  onOpenChange,
}: {
  virtualKey: RotatableVirtualKey | null;
  onOpenChange: (open: boolean) => void;
}) {
  const rotate = useRotateVirtualApiKey();
  const [gracePeriod, setGracePeriod] = useState(String(DEFAULT_GRACE_SECONDS));
  const [rotated, setRotated] = useState<RotatedVirtualKey | null>(null);
  const open = virtualKey !== null;

  useEffect(() => {
    if (open) {
      setGracePeriod(String(DEFAULT_GRACE_SECONDS));
      setRotated(null);
    }
  }, [open]);

  const handleRotate = async () => {
    if (!virtualKey) return;
    try {
      const result = await rotate.mutateAsync({
        id: virtualKey.id,
        gracePeriodSeconds: Number(gracePeriod),
      });
      if (result) setRotated(result);
    } catch {
      // handled by mutation
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="small"
      title={rotated ? "Virtual key rotated" : `Rotate "${virtualKey?.name}"`}
      description={
        rotated
          ? undefined
          : "Issue a new value for this key. Its settings, limits and usage history stay the same."
      }
    >
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (!rotated) void handleRotate();
        }}
      >
        <DialogBody className="space-y-4">
          {rotated ? (
            <RotatedKeySummary rotated={rotated} />
          ) : (
            <div className="space-y-2">
              <Label htmlFor="rotate-virtual-key-grace">
                Current value keeps working
              </Label>
              <Select value={gracePeriod} onValueChange={setGracePeriod}>
                <SelectTrigger id="rotate-virtual-key-grace" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GRACE_PERIOD_OPTIONS.map((option) => (
                    <SelectItem
                      key={option.seconds}
                      value={`${option.seconds}`}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                <span>
                  Give clients time to switch to the new value. Rotating again
                  ends any earlier grace period.
                </span>
              </p>
            </div>
          )}
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          <DialogCancelButton>
            {rotated ? "Close" : "Cancel"}
          </DialogCancelButton>
          {!rotated && (
            <Button type="submit" disabled={rotate.isPending}>
              {rotate.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              <span>Rotate key</span>
            </Button>
          )}
        </DialogStickyFooter>
      </form>
    </FormDialog>
  );
}

/** Automatic rotation interval; `null` means the key is only rotated by hand. */
export function AutoRotationSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  // A value set through the API that matches no preset still shows.
  const options = INTERVAL_OPTIONS.some((option) => option.seconds === value)
    ? INTERVAL_OPTIONS
    : [
        ...INTERVAL_OPTIONS,
        { seconds: value, label: `Every ${formatDays(value ?? 0)}` },
      ];
  return (
    <Select
      value={value === null ? OFF : String(value)}
      onValueChange={(next) => onChange(next === OFF ? null : Number(next))}
    >
      <SelectTrigger
        id={id}
        className="w-full"
        aria-label="Rotate automatically"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={option.seconds ?? OFF}
            value={option.seconds === null ? OFF : String(option.seconds)}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** One line on a key's rotation state, or null when there is none to show. */
export function describeRotation(key: {
  nextRotationAt: string | null;
  previousTokenExpiresAt: string | null;
}): string | null {
  if (
    key.previousTokenExpiresAt &&
    new Date(key.previousTokenExpiresAt) > new Date()
  ) {
    return `Old value works until ${formatRelativeTime(key.previousTokenExpiresAt)}`;
  }
  if (key.nextRotationAt) {
    return `Rotates ${formatRelativeTime(key.nextRotationAt, { pastLabel: "soon" })}`;
  }
  return null;
}

// ===================================================================
// Internal
// ===================================================================

function RotatedKeySummary({ rotated }: { rotated: RotatedVirtualKey }) {
  const graceNote = rotated.previousTokenExpiresAt
    ? `The previous value keeps working until ${new Date(
        rotated.previousTokenExpiresAt,
      ).toLocaleString()}.`
    : "The previous value no longer works.";
  if (!rotated.value) {
    return (
      <p className="text-sm text-muted-foreground">
        <span>
          {graceNote} The key's owner can copy the new value from Virtual Keys.
        </span>
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm">
        <span>Copy the new value now. {graceNote}</span>
      </p>
      <CopyableCode value={rotated.value} toastMessage="Key copied" />
    </div>
  );
}

function formatDays(seconds: number): string {
  const days = Math.round(seconds / DAY_SECONDS);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

const OFF = "off";
const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const DEFAULT_GRACE_SECONDS = DAY_SECONDS;

const GRACE_PERIOD_OPTIONS = [
  { seconds: 0, label: "Stop immediately" },
  { seconds: HOUR_SECONDS, label: "For 1 hour" },
  { seconds: DAY_SECONDS, label: "For 24 hours" },
  { seconds: 7 * DAY_SECONDS, label: "For 7 days" },
];

const INTERVAL_OPTIONS: Array<{ seconds: number | null; label: string }> = [
  { seconds: null, label: "Off" },
  { seconds: 7 * DAY_SECONDS, label: "Every 7 days" },
  { seconds: 30 * DAY_SECONDS, label: "Every 30 days" },
  { seconds: 90 * DAY_SECONDS, label: "Every 90 days" },
];
