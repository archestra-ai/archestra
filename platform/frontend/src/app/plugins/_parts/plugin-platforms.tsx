"use client";

import { useId } from "react";
import { Checkbox } from "@/components/ui/checkbox";

export type PluginPlatform = "posix" | "windows";

export function PluginPlatforms({
  value,
  onChange,
  disabled = false,
}: {
  value: PluginPlatform[];
  onChange: (value: PluginPlatform[]) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const toggle = (platform: PluginPlatform, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...value, platform]))
      : value.filter((item) => item !== platform);
    if (next.length > 0) onChange(next);
  };

  return (
    <fieldset className="space-y-2 md:col-span-2">
      <legend className="text-sm font-medium">Supported setup platforms</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <label
          htmlFor={`${id}-posix`}
          className="flex items-start gap-3 rounded-md border p-3"
        >
          <Checkbox
            id={`${id}-posix`}
            checked={value.includes("posix")}
            disabled={disabled}
            onCheckedChange={(checked) => toggle("posix", checked === true)}
          />
          <span>
            <span className="block text-sm font-medium">macOS / Linux</span>
            <span className="block text-xs text-muted-foreground">
              POSIX shell or cross-platform handlers.
            </span>
          </span>
        </label>
        <label
          htmlFor={`${id}-windows`}
          className="flex items-start gap-3 rounded-md border p-3"
        >
          <Checkbox
            id={`${id}-windows`}
            checked={value.includes("windows")}
            disabled={disabled}
            onCheckedChange={(checked) => toggle("windows", checked === true)}
          />
          <span>
            <span className="block text-sm font-medium">Windows</span>
            <span className="block text-xs text-muted-foreground">
              Mark only after reviewing native PowerShell, commandWindows, or a
              tested Git Bash handler.
            </span>
          </span>
        </label>
      </div>
    </fieldset>
  );
}
