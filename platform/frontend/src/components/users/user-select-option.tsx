"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export interface UserSelectOption {
  userId: string;
  name?: string | null;
  email?: string | null;
}

/**
 * The row shape both the single- and multi-select user pickers hand to their
 * underlying `Searchable*Select`. Kept in one place so the two pickers can't
 * drift on what a user row looks like or — more importantly — on `searchText`,
 * which decides what a typed query is matched against.
 */
export function buildUserSelectItem({
  user,
  disabled = false,
}: {
  user: UserSelectOption;
  disabled?: boolean;
}) {
  const displayName = getUserDisplayName(user);
  const email = user.email || null;

  return {
    value: user.userId,
    label: displayName,
    description: undefined,
    // Name and email are matched together so a query can span both
    // ("lovelace example.com").
    searchText: `${displayName} ${email || ""}`,
    disabled,
    content: (
      <div className="flex min-w-0 items-center gap-2">
        <Avatar className="shrink-0 h-5 w-5">
          <AvatarFallback className="text-[10px]">
            {getInitials(displayName)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1 flex flex-col">
          <span className="truncate">{displayName}</span>
          {email && (
            <span className="truncate text-xs text-muted-foreground">
              {email}
            </span>
          )}
        </div>
      </div>
    ),
    selectedContent: (
      <div className="flex min-w-0 items-center gap-2">
        <Avatar className="shrink-0 h-4 w-4">
          <AvatarFallback className="text-[8px]">
            {getInitials(displayName)}
          </AvatarFallback>
        </Avatar>
        <span className="truncate">{displayName}</span>
      </div>
    ),
  };
}

function getUserDisplayName(user: UserSelectOption): string {
  return user.name || user.email || user.userId || "Unknown user";
}

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return "U";
  }

  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
