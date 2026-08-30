import type { Permissions } from "@archestra/shared";
import { bundleConnectionHref, bundleEditHref } from "./bundle-page-config";

export type BundleAction = {
  id: "install" | "edit" | "delete";
  label: string;
  permissions?: Permissions;
  href?: string;
};

export function getBundleActions(bundleId: string): BundleAction[] {
  return [
    {
      id: "install",
      label: "Install",
      href: bundleConnectionHref(bundleId),
    },
    {
      id: "edit",
      label: "Edit",
      permissions: { bundle: ["update"] },
      href: bundleEditHref(bundleId),
    },
    {
      id: "delete",
      label: "Delete",
      permissions: { bundle: ["delete"] },
    },
  ];
}
