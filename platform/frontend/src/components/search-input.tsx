"use client";

import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
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

export function SearchInput({
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
}: SearchInputProps) {
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
    <div
      className={className ?? "relative w-full sm:w-[320px] sm:max-w-[320px]"}
    >
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <DebouncedInput
        initialValue={searchValue}
        onChange={handleChange}
        placeholder={computedPlaceholder}
        className={inputClassName ?? "w-full pl-9"}
        debounceMs={debounceMs}
      />
    </div>
  );
}

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
