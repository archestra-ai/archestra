"use client";

import { UserX } from "lucide-react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  buildUserSelectItem,
  type UserSelectOption,
} from "@/components/user-select-option";

export type { UserSelectOption };

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
  /**
   * Pinned above the search results and unaffected by filtering — for a
   * standing non-user choice like "Unassigned".
   */
  pinnedOption?: { value: string; label: string };
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
  pinnedOption,
}: UserSearchableSelectProps) {
  const items = users.map((user) => {
    const isDisabled = disabledUserIds?.has(user.userId) ?? false;
    return {
      ...buildUserSelectItem({ user, disabled: isDisabled }),
      checked: isDisabled,
    };
  });

  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      pinnedItems={
        pinnedOption
          ? [
              {
                value: pinnedOption.value,
                label: pinnedOption.label,
                // Same anatomy and height as a user option: an icon in the
                // avatar slot, the label where the name goes.
                content: (
                  <div className="flex min-h-8 min-w-0 items-center gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted">
                      <UserX className="h-3 w-3" />
                    </span>
                    <span className="truncate font-medium">
                      {pinnedOption.label}
                    </span>
                  </div>
                ),
                selectedContent: (
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted">
                      <UserX className="h-2.5 w-2.5" />
                    </span>
                    <span className="truncate">{pinnedOption.label}</span>
                  </div>
                ),
              },
            ]
          : undefined
      }
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
