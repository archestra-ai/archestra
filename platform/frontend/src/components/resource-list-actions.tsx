// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { ScopedResource } from "@archestra/shared";
import { MoreHorizontal, Shield } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useState } from "react";
import { ResourcePermissionsDialog } from "@/components/resource-permissions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHasPermissions } from "@/lib/auth/auth.query";

/**
 * Secondary list actions, with the same permission editor for every resource.
 * A page that lists more than one kind of resource names each one with a
 * label, and gets one Permissions button per kind. Other actions passed as
 * children go in a "More actions" menu.
 */
export function ResourceListActions({
  resource,
  label,
  alsoResources = [],
  children,
}: {
  resource: ScopedResource;
  /** Menu label for `resource` when `alsoResources` adds more kinds. */
  label?: string;
  alsoResources?: Array<{ resource: ScopedResource; label: string }>;
  children?: ReactNode;
}) {
  const { data: canReadGlobal } = useHasPermissions({
    accessPolicies: ["read"],
  });
  const { data: canUpdateGlobal } = useHasPermissions({
    accessPolicies: ["update"],
  });
  const [opened, setOpened] = useState<ScopedResource | null>(null);
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  // A deep link opens the first kind, as it always has.
  const linked = params.get("permissions") === "all";
  const kinds = [
    { resource, label: label ?? "Permissions" },
    ...alsoResources,
  ].filter(() => canReadGlobal || canUpdateGlobal);
  const onOpenChange = (open: boolean) => {
    if (!open) setOpened(null);
    if (!open && linked) {
      const next = new URLSearchParams(params.toString());
      next.delete("permissions");
      if (resource === "oauthClient") next.delete("permissionResource");
      router.replace(`${pathname}${next.size ? `?${next}` : ""}`, {
        scroll: false,
      });
    }
  };
  if (!kinds.length && !children) return null;
  return (
    <>
      {/* Permissions sits in plain sight, not behind the menu: it decides who
          sees everything on the page. */}
      {kinds.map((kind) => (
        <Button
          key={kind.resource}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpened(kind.resource)}
        >
          <Shield className="size-4" />
          {/* On a phone only the shield shows, so the header's actions still
              fit beside its title; the name stays for screen readers. */}
          <span className="max-sm:sr-only">{kind.label}</span>
        </Button>
      ))}
      {children && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="More actions"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">{children}</DropdownMenuContent>
        </DropdownMenu>
      )}
      {kinds.map((kind) => (
        <ResourcePermissionsDialog
          key={kind.resource}
          resource={kind.resource}
          open={
            opened === kind.resource ||
            (linked && opened === null && kind.resource === resource)
          }
          onOpenChange={onOpenChange}
        />
      ))}
    </>
  );
}
