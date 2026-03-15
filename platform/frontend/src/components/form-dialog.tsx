"use client";

import type * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type DialogSize = "small" | "medium" | "large";

type FormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string | React.ReactNode;
  description?: string | React.ReactNode;
  size?: DialogSize;
  children: React.ReactNode;
  preventCloseOnInteractOutside?: boolean;
  className?: string;
};

const sizeClasses: Record<DialogSize, string> = {
  small: "max-w-md max-h-[85vh] flex flex-col overflow-hidden",
  medium: "max-w-2xl max-h-[85vh] flex flex-col overflow-hidden",
  large: "max-w-5xl h-[90vh] flex flex-col overflow-hidden",
};

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  size = "medium",
  children,
  preventCloseOnInteractOutside,
  className,
}: FormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(sizeClasses[size], className)}
        onInteractOutside={
          preventCloseOnInteractOutside ? (e) => e.preventDefault() : undefined
        }
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
