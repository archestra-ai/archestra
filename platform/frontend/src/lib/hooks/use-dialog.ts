import { useState } from "react";

export function useDialogs<T extends string>() {
  const [dialogState, setDialogState] = useState<Record<T, boolean>>(
    {} as Record<T, boolean>,
  );

  const isDialogOpened = (dialogKey: T) => {
    return dialogState?.[dialogKey] === true;
  };
  const openDialog = (dialogKey: T) => {
    setDialogState((prev) => ({ ...prev, [dialogKey]: true }));
  };
  const closeDialog = (dialogKey: T) => {
    setDialogState((prev) => ({ ...prev, [dialogKey]: false }));
  };

  return {
    isDialogOpened,
    openDialog,
    closeDialog,
    /** Whether any dialog is open, so their code can load only then. */
    hasOpenDialog: Object.values<boolean>(dialogState).some(Boolean),
  };
}
