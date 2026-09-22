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

/** Secondary list actions, with the same permission editor for every resource. */
export function ResourceListActions({
  resource,
  children,
}: {
  resource: ScopedResource;
  children?: ReactNode;
}) {
  const capabilities = useScopedCapabilities();
  const [opened, setOpened] = useState(false);
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const linked = params.get("permissions") === "all";
  const canView =
    capabilities.data?.some(
      (grant) =>
        grant.resource === resource &&
        grant.scope === "*" &&
        grant.action === "read",
    ) ?? false;
  const onOpenChange = (open: boolean) => {
    setOpened(open);
    if (!open && linked) {
      const next = new URLSearchParams(params.toString());
      next.delete("permissions");
      router.replace(`${pathname}${next.size ? `?${next}` : ""}`, {
        scroll: false,
      });
    }
  };
  if (!canView && !children) return null;
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
          {children && canView && <DropdownMenuSeparator />}
          {canView && (
            <DropdownMenuItem onSelect={() => setOpened(true)}>
              <Shield className="size-4" />
              <span>Permissions</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {canView && (
        <ResourcePermissionsDialog
          resource={resource}
          open={opened || linked}
          onOpenChange={onOpenChange}
        />
      )}
    </>
  );
}
