"use client";

import { useMemo } from "react";
import { Label } from "@/components/ui/label";
import { UserSearchableSelect } from "@/components/user-searchable-select";
import type { UserSelectOption } from "@/components/user-select-option";
import { useSession } from "@/lib/auth/auth.query";
import { useMemberSearch } from "@/lib/member.query";

/**
 * Who a new key belongs to. Only admins see it; left on "Yourself", the key
 * belongs to its creator. The owner can reveal the key's token, and who else
 * can use it is set by its permissions.
 */
export function OwnerSelectField({
  id,
  value,
  onChange,
  onSelectedOwnerChange,
}: {
  id: string;
  /** The owner's user id; empty means the creator. */
  value: string;
  onChange: (userId: string) => void;
  onSelectedOwnerChange?: (owner: UserSelectOption) => void;
}) {
  const { data: session } = useSession();
  const selfId = session?.user?.id ?? "";
  const selfEmail = session?.user?.email ?? null;

  const {
    users: searchedUsers,
    onSearchQueryChange,
    emptyMessage,
  } = useMemberSearch({ selectedUserIds: value ? [value] : [] });

  const users = useMemo(() => {
    // The signed-in user is a pinned "Yourself" option, so the default owner
    // is an explicit, re-selectable choice and not only a placeholder.
    const others = searchedUsers.filter((user) => user.userId !== selfId);
    if (!selfId) return others;
    return [{ userId: selfId, name: "Yourself", email: selfEmail }, ...others];
  }, [searchedUsers, selfId, selfEmail]);

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Owner</Label>
      <UserSearchableSelect
        id={id}
        className="w-full"
        value={value || selfId}
        onValueChange={(userId) => {
          const owner = users.find((user) => user.userId === userId);
          if (owner) onSelectedOwnerChange?.(owner);
          onChange(userId === selfId ? "" : userId);
        }}
        users={users}
        placeholder="Yourself"
        onSearchQueryChange={onSearchQueryChange}
        emptyMessage={emptyMessage}
      />
    </div>
  );
}
