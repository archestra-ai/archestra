"use client";

import { useEffect, useMemo, useState } from "react";
import { Label } from "@/components/ui/label";
import {
  UserSearchableSelect,
  type UserSelectOption,
} from "@/components/user-searchable-select";
import { useSession } from "@/lib/auth/auth.query";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useMembersPaginated } from "@/lib/member.query";

/**
 * Whether the admin-only "Person" owner picker applies: only admins, and only
 * for personal-scope keys. Used both to render the field and to decide whether
 * to send an ownerId on create.
 */
export function shouldShowOwnerField(isAdmin: boolean, scope: string): boolean {
  return isAdmin && scope === "personal";
}

export function OwnerSelectField({
  value,
  onChange,
}: {
  value: string;
  onChange: (userId: string) => void;
}) {
  const { data: session } = useSession();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);
  const { data: membersData, isFetching } = useMembersPaginated({
    limit: 50,
    offset: 0,
    name: debouncedSearch || undefined,
  });
  // True while the typed query is still debouncing or its fetch is in flight,
  // so the dropdown shows "Searching…" instead of a premature "no results".
  const isSearching = search !== debouncedSearch || isFetching;

  // Accumulate every other member we've seen so a chosen owner stays
  // selectable even when a later search filters them out. The signed-in user
  // is excluded — picking yourself is the default (an empty selection).
  const [knownUsers, setKnownUsers] = useState<
    Record<string, UserSelectOption>
  >({});
  useEffect(() => {
    const selfId = session?.user?.id;
    setKnownUsers((prev) => {
      const next = { ...prev };
      for (const member of membersData?.data ?? []) {
        if (member.userId === selfId) continue;
        next[member.userId] = {
          userId: member.userId,
          name: member.name,
          email: member.email,
        };
      }
      return next;
    });
  }, [membersData, session?.user?.id]);

  const users = useMemo(() => Object.values(knownUsers), [knownUsers]);

  return (
    <div className="space-y-2">
      <Label>Person</Label>
      <UserSearchableSelect
        value={value}
        onValueChange={onChange}
        users={users}
        placeholder="Yourself"
        onSearchQueryChange={setSearch}
        emptyMessage={isSearching ? "Searching…" : "No matching users found."}
        hint="Pick a user to create this key on their behalf. Leave empty to own it yourself."
      />
    </div>
  );
}
