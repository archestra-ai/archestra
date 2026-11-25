/**
 * What the page offers a reader who has no cost export yet.
 *
 * - `loading`: an answer is still on its way, so neither a button nor a
 *   message shows.
 * - `cannot-schedule`: the reader may not schedule exports.
 * - `needs-provider`: there is no blob provider, and the reader may not add
 *   one.
 * - `add-provider`: Configure opens the add-blob-provider dialog, which leads
 *   on to the schedule dialog.
 * - `schedule`: Configure opens the schedule dialog.
 */
export type ConfigureStep =
  | "loading"
  | "cannot-schedule"
  | "needs-provider"
  | "add-provider"
  | "schedule";

/**
 * Configure opens the first step that is still missing. `undefined` means the
 * answer has not loaded yet.
 *
 * Whether the reader can schedule is asked first: the blob provider list is
 * not fetched for a reader who can only read exports, so its count never
 * arrives for them.
 */
export function configureStep({
  canSchedule,
  canAddProvider,
  providerCount,
}: {
  canSchedule: boolean | undefined;
  canAddProvider: boolean | undefined;
  providerCount: number | undefined;
}): ConfigureStep {
  if (canSchedule === undefined) return "loading";
  if (!canSchedule) return "cannot-schedule";
  if (providerCount === undefined) return "loading";
  if (providerCount > 0) return "schedule";
  if (canAddProvider === undefined) return "loading";
  return canAddProvider ? "add-provider" : "needs-provider";
}
