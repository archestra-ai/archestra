import { cookies } from "next/headers";
import type { TableCardViewMode } from "@/components/table-card-view";

/** The table/card preference a page saved under `storageKey`, from the request's cookies. */
export async function readSavedTableCardViewMode(
  storageKey: string,
): Promise<TableCardViewMode | undefined> {
  const value = (await cookies()).get(storageKey)?.value;
  return value === "cards" || value === "table" ? value : undefined;
}
