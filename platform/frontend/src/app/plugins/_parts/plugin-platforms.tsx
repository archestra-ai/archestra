"use client";

import {
  CONNECT_PLATFORM_OPTIONS,
  type ConnectPlatformOption,
} from "@/app/connection/platform.utils";
import { ConnectionPlatformMultiSelect } from "@/app/connection/platform-select";
import { Label } from "@/components/ui/label";

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
  return (
    <div className="space-y-2">
      <Label htmlFor="plugin-platforms">Supported setup platforms</Label>
      <ConnectionPlatformMultiSelect
        id="plugin-platforms"
        value={value.map(toConnectPlatform)}
        onValueChange={(platforms) => onChange(platforms.map(toPluginPlatform))}
        options={CONNECT_PLATFORM_OPTIONS}
        disabled={disabled}
      />
    </div>
  );
}

function toConnectPlatform(platform: PluginPlatform): ConnectPlatformOption {
  return platform === "posix" ? "macos" : "windows";
}

function toPluginPlatform(platform: ConnectPlatformOption): PluginPlatform {
  return platform === "macos" ? "posix" : "windows";
}
