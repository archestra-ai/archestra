"use client";

import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { buildUserSelectItem } from "@/components/user-select-option";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import {
  useMemberOptionsPage,
  useMemberOptionsReferences,
} from "@/lib/member-options.query";

import { cn } from "@/lib/utils/tailwind";

/** A lazy directory picker whose search and navigation retain every candidate. */
export function RemoteUserSelect({
  value,
  onValueChange,
  placeholder = "Select user",
  ariaLabel,
  className,
  pinnedOption,
  searchMode = "name_or_email",
  disabled,
}: {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  pinnedOption?: { value: string; label: string };
  searchMode?: "name" | "name_or_email";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const debouncedSearch = useDebouncedValue(search, 200);
  const pageQuery = useMemberOptionsPage({
    search: debouncedSearch,
    searchMode,
    enabled: open,
  });
  const selectedQuery = useMemberOptionsReferences({
    ids: value && value !== pinnedOption?.value ? [value] : [],
  });
  const selected = selectedQuery.data?.find((row) => row.id === value);
  const page = Math.min(
    pageIndex,
    Math.max(0, (pageQuery.data?.pages.length ?? 1) - 1),
  );
  const rows =
    search === debouncedSearch ? (pageQuery.data?.pages[page]?.data ?? []) : [];
  const hasNext =
    search === debouncedSearch &&
    (page + 1 < (pageQuery.data?.pages.length ?? 0) || pageQuery.hasNextPage);
  const select = (id: string) => {
    onValueChange(id);
    setOpen(false);
    setSearch("");
    setPageIndex(0);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label={ariaLabel ?? placeholder}
          aria-expanded={open}
          className={cn("justify-between", className)}
          disabled={disabled}
        >
          <span>
            {value === pinnedOption?.value
              ? pinnedOption.label
              : selected?.name ||
                (searchMode === "name_or_email"
                  ? selected?.email
                  : undefined) ||
                value ||
                placeholder}
          </span>
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search users"
            value={search}
            onValueChange={(next) => {
              setSearch(next);
              setPageIndex(0);
            }}
          />
          <CommandList>
            {pinnedOption && (
              <CommandGroup>
                <CommandItem
                  value={pinnedOption.value}
                  onSelect={() => select(pinnedOption.value)}
                >
                  <span>{pinnedOption.label}</span>
                  {value === pinnedOption.value && <Check />}
                </CommandItem>
              </CommandGroup>
            )}
            {pageQuery.isPending || search !== debouncedSearch ? (
              <p className="p-3 text-sm">
                <span>Searching…</span>
              </p>
            ) : pageQuery.isError ? (
              <Button
                type="button"
                variant="link"
                onClick={() => pageQuery.refetch()}
              >
                Retry loading users
              </Button>
            ) : (
              <CommandGroup>
                {rows.map((row) => {
                  const item = buildUserSelectItem({
                    user: { userId: row.id, name: row.name, email: row.email },
                  });
                  return (
                    <CommandItem
                      key={row.id}
                      value={row.id}
                      onSelect={() => select(row.id)}
                    >
                      {item.content}
                      {value === row.id && <Check />}
                    </CommandItem>
                  );
                })}
                {rows.length === 0 && (
                  <p className="p-3 text-sm">
                    <span>No matching users</span>
                  </p>
                )}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
        {(page > 0 || hasNext) && (
          <nav
            aria-label="User pages"
            className="flex items-center justify-between border-t p-2"
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={page === 0}
              onClick={() => setPageIndex(page - 1)}
            >
              Previous users
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                !hasNext ||
                pageQuery.isFetchingNextPage ||
                search !== debouncedSearch
              }
              onClick={async () => {
                setPageIndex(page + 1);
                if (page + 1 >= (pageQuery.data?.pages.length ?? 0))
                  await pageQuery.fetchNextPage();
              }}
            >
              Next users
            </Button>
          </nav>
        )}
        {selectedQuery.isError && (
          <Button
            type="button"
            variant="link"
            onClick={() => selectedQuery.refetch()}
          >
            Retry selected user
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
