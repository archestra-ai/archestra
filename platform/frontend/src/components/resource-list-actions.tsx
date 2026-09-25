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
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useScopedCapabilities } from "@/lib/auth/auth.query";

/**
 * Secondary list actions, with the same permission editor for every resource.
 * A page that lists more than one kind of resource names each one with a
 * label, and gets one Permissions item per kind.
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
  const capabilities = useScopedCapabilities();
  const [opened, setOpened] = useState<ScopedResource | null>(null);
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  // A deep link opens the first kind, as it always has.
  const linked = params.get("permissions") === "all";
  const canView = (kind: ScopedResource) =>
    capabilities.data?.some(
      (grant) =>
        grant.resource === kind &&
        grant.scope === "*" &&
        grant.action === "read",
    ) ?? false;
  const kinds = [
    { resource, label: label ?? "Permissions" },
    ...alsoResources,
  ].filter((kind) => canView(kind.resource));
  const onOpenChange = (open: boolean) => {
    if (!open) setOpened(null);
    if (!open && linked) {
      const next = new URLSearchParams(params.toString());
      next.delete("permissions");
      router.replace(`${pathname}${next.size ? `?${next}` : ""}`, {
        scroll: false,
      });
    }
  };
  if (!kinds.length && !children) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="More actions"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {children}
          {children && kinds.length > 0 && <DropdownMenuSeparator />}
          {kinds.map((kind) => (
            <DropdownMenuItem
              key={kind.resource}
              onSelect={() => setOpened(kind.resource)}
            >
              <Shield className="size-4" />
              <span>{kind.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
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
