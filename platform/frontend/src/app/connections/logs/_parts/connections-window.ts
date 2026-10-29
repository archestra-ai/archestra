import type { AdoptionWindow } from "@/lib/connected-client.query";

/** The date range the whole Agent connections page shows. */
export interface ConnectionsWindow extends AdoptionWindow {
  /** "last 30 days", or the picked range as the picker shows it. */
  label: string;
  /** Whether the user picked the range, rather than the default. */
  picked: boolean;
}
