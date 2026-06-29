"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SearchableSelect } from "@/components/ui/searchable-select";

export interface UserSelectOption {
  userId: string;
  name?: string | null;
  email?: string | null;
}

export interface UserSearchableSelectProps {
  value: string;
  onValueChange: (userId: string) => void;
  users: UserSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  className?: string;
  disabled?: boolean;
  disabledUserIds?: Set<string>;
  onSearchQueryChange?: (value: string) => void;
  emptyMessage?: string;
  hint?: string;
}

function getUserDisplayName(user: UserSelectOption): string {
  return user.name || user.email || user.userId || "Unknown user";
}

function getUserEmail(user: UserSelectOption): string | null {
  return user.email || null;
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

export function UserSearchableSelect({
  value,
  onValueChange,
  users,
  placeholder = "Select user",
  searchPlaceholder = "Search users by name or email",
  className,
  disabled = false,
  disabledUserIds,
  onSearchQueryChange,
  emptyMessage = "No matching users found.",
  hint,
}: UserSearchableSelectProps) {
  const items = users.map((user) => {
    const isDisabled = disabledUserIds?.has(user.userId) ?? false;
    const email = getUserEmail(user);
    const displayName = getUserDisplayName(user);

    return {
      value: user.userId,
      label: displayName,
      description: undefined,
      searchText: `${displayName} ${email || ""}`,
      disabled: isDisabled,
      checked: isDisabled,
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
  });

  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      className={className}
      disabled={disabled}
      onSearchQueryChange={onSearchQueryChange}
      items={items}
      emptyMessage={emptyMessage}
      hint={hint}
    />
  );
}
