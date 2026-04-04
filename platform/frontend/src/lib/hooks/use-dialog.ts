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
  };
}
