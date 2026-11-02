/**
 * The confirmation for each action on a run, worded once so the run page, a
 * row of the Runs list, and a bulk action on several runs say the same thing.
 */
export function runActionConfirmCopy({
  action,
  count,
  stillRunning = 0,
}: {
  action: RunAction;
  /** How many runs the action reaches. */
  count: number;
  /** Selected runs that Delete leaves alone because they have not ended. */
  stillRunning?: number;
}): { title: string; description: string; confirmLabel: string } {
  const one = count === 1;
  if (action === "stop")
    return {
      title: one ? "Stop run?" : `Stop ${count} runs?`,
      description: one
        ? "The run stops. Its saved files and history stay, so you can resume it later."
        : "The runs stop. Their saved files and history stay, so you can resume them later.",
      confirmLabel: one ? "Stop run" : "Stop runs",
    };
  if (action === "files")
    return {
      title: one
        ? "Delete saved files?"
        : `Delete the saved files of ${count} runs?`,
      description: one
        ? "Deleting the saved files frees their storage. You cannot resume the run afterward. Its history stays."
        : "Deleting the saved files frees their storage. You cannot resume these runs afterward. Their history stays.",
      confirmLabel: "Delete saved files",
    };
  return {
    title: one ? "Delete run?" : `Delete ${count} runs?`,
    description: `${
      one
        ? "Deleting a run permanently removes its history, output, and saved files."
        : "Deleting these runs permanently removes their history, output, and saved files."
    }${stillRunningNote(stillRunning)}`,
    confirmLabel: one ? "Delete run" : "Delete runs",
  };
}

export type RunAction = "stop" | "files" | "delete";

function stillRunningNote(count: number) {
  if (count === 1) return " The run that is still running stays.";
  if (count > 1) return ` The ${count} runs that are still running stay.`;
  return "";
}
