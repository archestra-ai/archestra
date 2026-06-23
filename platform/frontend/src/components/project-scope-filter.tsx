"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { parseProjectScope } from "@/lib/projects/project-list-scope";

/**
 * Projects-list scope filter, mirroring the Agents page personal/shared filter.
 * "Other users" is admin-only (`project:admin`) — the oversight view of projects
 * owned by other members.
 */
export function ProjectScopeFilter() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { data: isProjectAdmin } = useHasPermissions({ project: ["admin"] });

  const scope = parseProjectScope(searchParams.get("scope"));
  // Don't surface a stale "others" selection to a non-admin (e.g. a shared URL).
  const value = scope === "others" && !isProjectAdmin ? "all" : scope;

  const handleScopeChange = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "all") {
        params.delete("scope");
      } else {
        params.set("scope", next);
      }
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  return (
    <Select value={value} onValueChange={handleScopeChange}>
      <SelectTrigger className="w-[180px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" side="bottom" align="start">
        <SelectItem value="all">All projects</SelectItem>
        <SelectItem value="personal">Personal</SelectItem>
        <SelectItem value="shared">Shared with me</SelectItem>
        {isProjectAdmin && (
          <>
            <SelectSeparator />
            <SelectItem value="others">Other users</SelectItem>
          </>
        )}
      </SelectContent>
    </Select>
  );
}
