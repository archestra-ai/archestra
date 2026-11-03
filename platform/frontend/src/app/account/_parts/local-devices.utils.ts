import type { LocalDevice } from "@/lib/local-devices.query";

export type DevicePlatform = NonNullable<LocalDevice["platform"]>;
type DeviceArch = NonNullable<LocalDevice["arch"]>;

export const PLATFORM_LABELS: Record<DevicePlatform, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

const ARCH_LABELS: Record<DevicePlatform, Record<DeviceArch, string>> = {
  darwin: { arm64: "Apple silicon", x64: "Intel" },
  win32: { arm64: "Arm", x64: "x64" },
  linux: { arm64: "Arm", x64: "x64" },
};

export const STATUS_LABELS: Record<LocalDevice["status"], string> = {
  pending: "Waiting to connect",
  online: "Online",
  offline: "Offline",
  revoked: "Revoked",
};

/** "macOS · Apple silicon · 0.4.1", omitting whatever the device hasn't reported. */
export function describeDevice(device: LocalDevice): string | null {
  const parts = [
    device.platform ? PLATFORM_LABELS[device.platform] : null,
    device.platform && device.arch
      ? ARCH_LABELS[device.platform][device.arch]
      : null,
    device.appVersion ? `v${device.appVersion}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export const DEVICE_NAME_MAX_LENGTH = 128;
