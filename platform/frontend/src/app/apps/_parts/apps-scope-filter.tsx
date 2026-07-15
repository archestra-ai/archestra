"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserSearchableMultiSelect } from "@/components/user-searchable-multi-select";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useOrganizationMembers } from "@/lib/organization.query";

type ScopeValue = "personal" | "team" | "org";
type OwnerValue = "mine" | "others";

/**
 * Apps-list scope filter, mirroring the Projects page. Scope is the app's
 * visibility — Personal (private to the author) / Team / Organization. An
 * `app:admin` additionally gets a "My apps / Other users" sub-filter under
 * Personal and can narrow to specific owners, so they can find and oversee
 * other users' personal apps the same way they do projects.
 */
export function AppsScopeFilter() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const scope = (searchParams.get("scope") as ScopeValue | null) ?? undefined;
  const authorIdsParam = searchParams.get("authorIds");
  const excludeAuthorIdsParam = searchParams.get("excludeAuthorIds");

  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const selectedAuthorIds = useMemo(
    () => (authorIdsParam ? authorIdsParam.split(",") : []),
    [authorIdsParam],
  );

  const { data: isAppAdmin } = useHasPermissions({ app: ["admin"] });

  const ownerFilter: OwnerValue = useMemo(() => {
    if (scope !== "personal" || !isAppAdmin) return "mine";
    if (excludeAuthorIdsParam) return "others";
    if (!authorIdsParam) return "mine";
    if (currentUserId) {
      const ids = authorIdsParam.split(",");
      if (ids.length === 1 && ids[0] === currentUserId) return "mine";
    }
    return "others";
  }, [scope, isAppAdmin, authorIdsParam, excludeAuthorIdsParam, currentUserId]);

  const showOwnerSelect = scope === "personal" && !!isAppAdmin;
  const showMembersMultiSelect = showOwnerSelect && ownerFilter === "others";
  const { data: members } = useOrganizationMembers(showMembersMultiSelect);

  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") params.delete(key);
        else params.set(key, value);
      }
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const handleScopeChange = useCallback(
    (value: string) => {
      if (value === "personal") {
        // Default the owner sub-filter to "My apps".
        updateUrlParams({
          scope: "personal",
          authorIds: currentUserId ?? null,
          excludeAuthorIds: null,
        });
      } else {
        updateUrlParams({
          scope: value === "all" ? null : value,
          authorIds: null,
          excludeAuthorIds: null,
        });
      }
    },
    [updateUrlParams, currentUserId],
  );

  const handleOwnerChange = useCallback(
    (value: string) => {
      if (value === "mine") {
        updateUrlParams({
          authorIds: currentUserId ?? null,
          excludeAuthorIds: null,
        });
      } else {
        // "Other users" with no specific pick = everyone except me.
        updateUrlParams({
          authorIds: null,
          excludeAuthorIds: currentUserId ?? null,
        });
      }
    },
    [updateUrlParams, currentUserId],
  );

  const handleAuthorIdsChange = useCallback(
    (values: string[]) => {
      updateUrlParams({
        authorIds: values.length > 0 ? values.join(",") : null,
        excludeAuthorIds: values.length > 0 ? null : (currentUserId ?? null),
      });
    },
    [updateUrlParams, currentUserId],
  );

  const userOptions = useMemo(
    () =>
      (members ?? [])
        .filter((m) => m.id !== currentUserId)
        .map((m) => ({ userId: m.id, name: m.name, email: m.email })),
    [members, currentUserId],
  );

  return (
    <div className="flex items-center gap-2">
      <Select value={scope ?? "all"} onValueChange={handleScopeChange}>
        <SelectTrigger className="w-[160px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" side="bottom" align="start">
          <SelectItem value="all">All apps</SelectItem>
          <SelectItem value="personal">Personal</SelectItem>
          <SelectItem value="team">Team</SelectItem>
          <SelectItem value="org">Organization</SelectItem>
        </SelectContent>
      </Select>
      {showOwnerSelect && (
        <Select value={ownerFilter} onValueChange={handleOwnerChange}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" side="bottom" align="start">
            <SelectItem value="mine">My apps</SelectItem>
            <SelectItem value="others">Other users</SelectItem>
          </SelectContent>
        </Select>
      )}
      {showMembersMultiSelect && (
        <UserSearchableMultiSelect
          value={selectedAuthorIds}
          onValueChange={handleAuthorIdsChange}
          users={userOptions}
          placeholder="All users"
          className="w-[200px]"
          showSelectedBadges={false}
          selectedSuffix={(n) => `${n === 1 ? "user" : "users"} selected`}
        />
      )}
    </div>
  );
}
