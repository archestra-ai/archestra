import { type ClassValue, clsx } from "clsx";
import { format } from "date-fns";
import { twMerge } from "tailwind-merge";

export const DEFAULT_TABLE_LIMIT = 10;
export const DEFAULT_AGENTS_PAGE_SIZE = 20;
export const DEFAULT_TOOLS_PAGE_SIZE = 50;

// Default sorting values - used for both initial state and SSR matching
export const DEFAULT_SORT_BY = "createdAt" as const;
export const DEFAULT_SORT_DIRECTION = "desc" as const;

// Default filter values for tools page - used for both initial state and SSR matching
export const DEFAULT_FILTER_ALL = "all" as const;

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate({
  date,
  dateFormat = "MM/dd/yyyy HH:mm:ss",
}: {
  date: string;
  dateFormat?: string;
}) {
  return format(new Date(date), dateFormat);
}

/**
 * Unwrap a Node-style error `code` from nested error objects (AggregateError, cause, errors[]).
 * Used by server routes to detect network errors like ECONNREFUSED.
 */
export function unwrapNetworkErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const anyErr = error as { code?: unknown; cause?: unknown; errors?: unknown[] };
  if (typeof anyErr.code === "string") return anyErr.code;
  if (anyErr.cause) {
    const cause: unknown = (anyErr.cause as { code?: unknown; errors?: unknown[] }) ?? anyErr.cause;
    const nested =
      (cause as { code?: unknown }).code ??
      (Array.isArray((cause as { errors?: unknown[] }).errors)
        ? (cause as { errors?: unknown[] }).errors?.[0] &&
          ((cause as { errors?: unknown[] }).errors?.[0] as { code?: unknown })?.code
        : undefined);
    if (typeof nested === "string") return nested;
  }
  if (Array.isArray(anyErr.errors) && anyErr.errors.length > 0) {
    const nested = (anyErr.errors[0] as { code?: unknown })?.code;
    if (typeof nested === "string") return nested;
  }
  return undefined;
}
