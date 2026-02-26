import * as Sentry from "@sentry/nextjs";
import type { ApiError } from "@shared";
import { type ClassValue, clsx } from "clsx";
import { format } from "date-fns";
import { toast } from "sonner";
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
 * Convert an API SDK error object into a proper Error instance.
 * Use this instead of `throw error` to avoid Sentry's
 * "Object captured as exception with keys: error" warning.
 */
export function toApiError(error: {
  error: Partial<ApiError> | Error;
}): Error {
  if (error.error instanceof Error) return error.error;
  return new Error(error.error?.message ?? "API request failed");
}

export function handleApiError(error: { error: Partial<ApiError> | Error }) {
  if (typeof window !== "undefined") {
    // we show toast only on the client side
    toast.error(error.error?.message ?? "API request failed");
  }
  // Wrap in a proper Error instance so Sentry gets a real stack trace instead
  // of "Object captured as exception with keys: error"
  const sentryError =
    error.error instanceof Error
      ? error.error
      : new Error(error.error?.message ?? "API request failed");
  Sentry.captureException(sentryError, { extra: { originalError: error } });
  // we log the error on the server side
  console.error(error);
}
