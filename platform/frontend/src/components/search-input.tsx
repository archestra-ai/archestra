"use client";

import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { DebouncedInput } from "./debounced-input";

type SearchInputProps = {
  placeholder?: string;
  paramName?: string;
  debounceMs?: number;
  className?: string;
  inputClassName?: string;
  onSearchChange?: (value: string) => void;
};

export function SearchInput({
  placeholder = "Search...",
  paramName = "search",
  debounceMs = 400,
  className,
  inputClassName,
  onSearchChange,
}: SearchInputProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  const searchValue = searchParams.get(paramName) || "";

  const handleChange = useCallback(
    (value: string) => {
      onSearchChange?.(value);
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(paramName, value);
      } else {
        params.delete(paramName);
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname, paramName, onSearchChange],
  );

  return (
    <div className={className ?? "relative w-[250px]"}>
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <DebouncedInput
        initialValue={searchValue}
        onChange={handleChange}
        placeholder={placeholder}
        className={inputClassName ?? "pl-9"}
        debounceMs={debounceMs}
      />
    </div>
  );
}
