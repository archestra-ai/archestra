"use client";

import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useLocalDevices,
  useRenameLocalDevice,
  useRevokeLocalDevice,
} from "@/lib/local-devices.query";
import { useOrganization } from "@/lib/organization.query";

export type { LocalDevice } from "@/lib/local-devices.query";

/** Devices enroll through browser-approved Connect; this page manages them. */
export function useLocalDevicesController() {
  const organization = useOrganization();
  const { data: canManageOrg } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const enabled = organization.data?.deviceMcpEnabled === true;
  const devices = useLocalDevices({ enabled });
  const rename = useRenameLocalDevice();
  const revoke = useRevokeLocalDevice();
  const availability = organization.isPending
    ? "loading"
    : organization.isError
      ? "error"
      : !enabled
        ? "disabled"
        : devices.isPending
          ? "loading"
          : devices.isLoadingError
            ? "error"
            : "ready";
  return {
    availability,
    canManageOrg,
    devices: (devices.data ?? []).filter(
      (device) => device.status !== "revoked",
    ),
    error: organization.error ?? devices.error,
    retry: () => {
      void organization.refetch();
      if (enabled) void devices.refetch();
    },
    renamingId: rename.isPending ? (rename.variables?.id ?? null) : null,
    revokingId: revoke.isPending ? (revoke.variables ?? null) : null,
    rename: (id: string, name: string) =>
      rename.mutateAsync({ id, name: name.trim() }).then(
        () => true,
        () => false,
      ),
    revoke: (id: string) =>
      revoke.mutateAsync(id).then(
        () => true,
        () => false,
      ),
  };
}
export type LocalDevicesController = ReturnType<
  typeof useLocalDevicesController
>;
