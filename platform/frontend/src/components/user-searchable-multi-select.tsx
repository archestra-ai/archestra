"use client";

import { SearchableMultiSelect } from "@/components/searchable-multi-select";
import {
  buildUserSelectItem,
  type UserSelectOption,
} from "@/components/user-select-option";

export type { UserSelectOption };

export interface UserSearchableMultiSelectProps {
  value: string[];
  onValueChange: (userIds: string[]) => void;
  users: UserSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  className?: string;
  disabled?: boolean;
  disabledUserIds?: Set<string>;
  onSearchQueryChange?: (value: string) => void;
  emptyMessage?: string;
  maxBadgeDisplay?: number;
  maxSelected?: number;
  showSelectedBadges?: boolean;
  selectedSuffix?: string | ((count: number) => string);
}

export function UserSearchableMultiSelect({
  value,
  onValueChange,
  users,
  placeholder = "Select users",
  searchPlaceholder = "Search users by name or email",
  className,
  disabled = false,
  disabledUserIds,
  onSearchQueryChange,
  emptyMessage = "No matching users found.",
  maxBadgeDisplay = 3,
  maxSelected,
  showSelectedBadges = true,
  selectedSuffix = "selected",
}: UserSearchableMultiSelectProps) {
  const items = users.map((user) =>
    buildUserSelectItem({
      user,
      disabled: disabledUserIds?.has(user.userId) ?? false,
    }),
  );

  return (
    <SearchableMultiSelect
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      className={className}
      disabled={disabled}
      onSearchQueryChange={onSearchQueryChange}
      items={items}
      emptyMessage={emptyMessage}
      maxBadgeDisplay={maxBadgeDisplay}
      maxSelected={maxSelected}
      showSelectedBadges={showSelectedBadges}
      selectedSuffix={selectedSuffix}
    />
  );
}
