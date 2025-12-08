import { type ClassValue, clsx } from "clsx";
import { format } from "date-fns";
import { twMerge } from "tailwind-merge";

export const DEFAULT_TABLE_LIMIT = 10;
export const DEFAULT_AGENTS_PAGE_SIZE = 20;
export const DEFAULT_TOOLS_PAGE_SIZE = 50;

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
