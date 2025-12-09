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
