"use client";

import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { forwardRef, useCallback, useState } from "react";
import { useReportSearchInFlight } from "@/lib/hooks/use-is-app-loading";
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
  /**
   * Whether the list this box filters is currently fetching.
   *
   * The box already lights up on its own for the debounce and the commit that
   * follows it; this extends the same indicator across the request the commit
   * triggers, so one continuous signal covers keystroke to results. Pass the
   * query's `isFetching` — the same flag the table gets as `isLoading`.
   *
   * Only ever consulted while the box actually holds a search term. Callers
   * pass `isFetching`, which is true for the list's first load and for every
   * background refetch as well, so taking it at face value lit the magnifier
   * on pages nobody was searching — and, worse, told `useReportSearchInFlight`
   * a search was running, which is what suppresses the sidebar toggle's
   * spinner. An ordinary page load would light this box and silence the one
   * indicator that was supposed to report it.
   */
  isLoading?: boolean;
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
      isLoading = false,
    }: SearchInputProps,
    ref,
  ) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const pathname = usePathname();
    const [isCommitPending, setIsCommitPending] = useState(false);

    const searchValue = value ?? searchParams.get(paramName) ?? "";
    const computedPlaceholder =
      objectNamePlural && searchFields?.length
        ? `Search ${objectNamePlural} by ${formatSearchFields(searchFields)}`
        : placeholder;

    // Typing was the part with no feedback at all: the debounce, the commit and
    // the request that follows it all used to pass under a static magnifier.
    // An empty box is not searching, whatever the list behind it is doing.
    const isBusy = isCommitPending || (isLoading && searchValue !== "");

    // The sidebar toggle's spinner reports that the app itself is loading. This
    // wait is already reported twice over, right where the user is looking, so
    // it sits this one out.
    useReportSearchInFlight(isBusy);

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
        {/* The spinner takes the magnifier's exact place rather than sitting
            beside it, so a search in flight reads as the icon changing state
            and nothing in the field moves. Both are always mounted and cross
            fade; swapping the elements instead made the icon flicker on every
            keystroke, and the box is at most one debounce away from busy. */}
        <span className="pointer-events-none absolute left-3 top-1/2 z-10 block size-4 -translate-y-1/2">
          <Search
            aria-hidden
            className={cn(
              "absolute inset-0 size-4 text-muted-foreground transition-opacity duration-150",
              isBusy && "opacity-0",
            )}
          />
          <span
            aria-hidden
            className={cn(
              "absolute inset-0 transition-opacity duration-150",
              isBusy ? "opacity-100" : "opacity-0",
            )}
          >
            <span className="absolute inset-0 rounded-full border-2 border-muted-foreground/25" />
            <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-foreground motion-reduce:animate-none" />
          </span>
        </span>
        <DebouncedInput
          ref={ref}
          initialValue={searchValue}
          onChange={handleChange}
          onPendingChange={setIsCommitPending}
          // The spinner is decorative; the field carries the state itself so
          // assistive tech hears it without a live region announcing every
          // keystroke's pause.
          aria-busy={isBusy}
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
