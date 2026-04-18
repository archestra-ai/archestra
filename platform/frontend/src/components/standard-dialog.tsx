"use client";

import type * as React from "react";

import { FormDialog, type FormDialogProps } from "@/components/form-dialog";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type StandardDialogProps = FormDialogProps & {
  bodyClassName?: string;
  footer?: React.ReactNode;
  footerClassName?: string;
};

export type StandardFormDialogProps = Omit<StandardDialogProps, "children"> & {
  children: React.ReactNode;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  formClassName?: string;
};

export function StandardDialog({
  children,
  bodyClassName,
  footer,
  footerClassName,
  ...props
}: StandardDialogProps) {
  return (
    <FormDialog {...props}>
      <DialogBody className={bodyClassName}>{children}</DialogBody>
      {footer ? (
        <DialogStickyFooter className={cn("mt-0", footerClassName)}>
          {footer}
        </DialogStickyFooter>
      ) : null}
    </FormDialog>
  );
}

export function StandardFormDialog({
  children,
  bodyClassName,
  footer,
  footerClassName,
  formClassName,
  onSubmit,
  ...props
}: StandardFormDialogProps) {
  return (
    <FormDialog {...props}>
      <DialogForm
        className={cn("flex min-h-0 flex-1 flex-col", formClassName)}
        onSubmit={onSubmit}
      >
        <DialogBody className={bodyClassName}>{children}</DialogBody>
        {footer ? (
          <DialogStickyFooter className={cn("mt-0", footerClassName)}>
            {footer}
          </DialogStickyFooter>
        ) : null}
      </DialogForm>
    </FormDialog>
  );
}
