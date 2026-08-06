"use client";

import { useMemo } from "react";
import { Label } from "@/components/ui/label";
import { UserSearchableSelect } from "@/components/user-searchable-select";
import type { UserSelectOption } from "@/components/user-select-option";
import { useSession } from "@/lib/auth/auth.query";
import { useMemberSearch } from "@/lib/member.query";

/**
 * Whether the admin-only "Key owner" picker applies: only admins, and only
 * for personal-scope keys. Used both to render the field and to decide whether
 * to send an ownerId on create.
 */
export function shouldShowOwnerField(isAdmin: boolean, scope: string): boolean {
  return isAdmin && scope === "personal";
}

export function OwnerSelectField({
  value,
  onChange,
  onSelectedOwnerChange,
}: {
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
    // The signed-in user is listed as a pinned "Yourself" option instead of
    // their own member entry, so the default owner is an explicit,
    // re-selectable choice rather than only an empty placeholder.
    const others = searchedUsers.filter((user) => user.userId !== selfId);
    if (!selfId) {
      return others;
    }
    return [{ userId: selfId, name: "Yourself", email: selfEmail }, ...others];
  }, [searchedUsers, selfId, selfEmail]);

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label>Key owner</Label>
        <p className="text-xs text-muted-foreground">
          Create this key on behalf of another member — it becomes their
          personal key to view and manage.
        </p>
      </div>
      <UserSearchableSelect
        className="w-full"
        value={value || selfId}
        onValueChange={(userId) => {
          const owner = users.find((user) => user.userId === userId);
          if (owner) {
            onSelectedOwnerChange?.(owner);
          }
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
