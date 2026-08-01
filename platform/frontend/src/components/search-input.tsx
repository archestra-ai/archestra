"use client";

import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { forwardRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { DebouncedInput } from "./debounced-input";

type SearchInputProps = {
  placeholder?: string;
  objectNamePlural?: string;
  searchFields?: string[];
  paramName?: string;
  debounceMs?: number;
  className?: string;
  inputClassName?: string;
  onSearchChange?: (value: string) => void;
  value?: string;
  syncQueryParams?: boolean;
};

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput(
    {
      placeholder = "Search...",
      objectNamePlural,
      searchFields,
      paramName = "search",
      debounceMs = 400,
      className,
      inputClassName,
      onSearchChange,
      value,
      syncQueryParams = true,
    }: SearchInputProps,
    ref,
  ) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const pathname = usePathname();

    const searchValue = value ?? searchParams.get(paramName) ?? "";
    const computedPlaceholder =
      objectNamePlural && searchFields?.length
        ? `Search ${objectNamePlural} by ${formatSearchFields(searchFields)}`
        : placeholder;

    const handleChange = useCallback(
      (value: string) => {
        onSearchChange?.(value);
        if (!syncQueryParams) return;
        const params = new URLSearchParams(searchParams.toString());
        if (value) {
          params.set(paramName, value);
        } else {
          params.delete(paramName);
        }
        params.set("page", "1");
        router.push(`${pathname}?${params.toString()}`, { scroll: false });
      },
      [
        onSearchChange,
        paramName,
        pathname,
        router,
        searchParams,
        syncQueryParams,
      ],
    );

    return (
      // `relative` and `pl-9` are structural: the magnifier is absolutely
      // positioned inside the wrapper and the input reserves room for it. They
      // are applied here rather than left to the caller's `className` /
      // `inputClassName` — a caller that overrode either without repeating them
      // detached the icon from the input entirely. Caller classes still come
      // last so sizing and colours win.
      <div
        className={cn(
          "relative",
          className ?? "w-full sm:w-[320px] sm:max-w-[320px]",
        )}
      >
        <Search className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <DebouncedInput
          ref={ref}
          initialValue={searchValue}
          onChange={handleChange}
          placeholder={computedPlaceholder}
          className={cn("pl-9", inputClassName ?? "w-full")}
          debounceMs={debounceMs}
        />
      </div>
    );
  },
);
SearchInput.displayName = "SearchInput";

function formatSearchFields(searchFields: string[]) {
  if (searchFields.length === 1) {
    return searchFields[0];
  }

  if (searchFields.length === 2) {
    return `${searchFields[0]} and ${searchFields[1]}`;
  }

  const allButLast = searchFields.slice(0, -1).join(", ");
  const last = searchFields.at(-1);

  return `${allButLast}, and ${last}`;
}
