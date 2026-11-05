"use client";

import type { ReactNode } from "react";
import {
  StandardDialog,
  type StandardDialogProps,
} from "@/components/standard-dialog";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";

export function ConnectionSignInDialog({
  action,
  ...props
}: Pick<
  StandardDialogProps,
  "open" | "onOpenChange" | "title" | "description"
> & {
  action: ReactNode;
}) {
  return (
    <StandardDialog
      {...props}
      size="small"
      className="sm:max-w-xl"
      footer={<DialogCancelButton>Cancel</DialogCancelButton>}
    >
      {action}
    </StandardDialog>
  );
}
