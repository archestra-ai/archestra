"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Low-level dialog primitives.
 *
 * Prefer the shared wrappers for normal product dialogs:
 * - `StandardDialog`
 * - `StandardFormDialog`
 * - `DeleteConfirmDialog`
 *
 * Use these primitives directly only for intentionally custom layouts.
 */
function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Low-level dialog content shell for custom modal layouts.
 *
 * If your dialog fits the standard product shell, prefer `StandardDialog`,
 * `StandardFormDialog`, or `DeleteConfirmDialog` instead of assembling the
 * primitives manually.
 */
function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          // Please keep this class when updating dialog component
          "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 flex w-full translate-x-[-50%] translate-y-[-50%] flex-col rounded-lg border pt-4 shadow-lg duration-200 max-w-4xl",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "flex flex-col gap-2 border-b px-4 pb-4 text-center sm:text-left",
        className,
      )}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <DialogStickyFooter className={className} {...props} />;
}

function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn(
        "min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

function DialogStickyFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        // Counteract DialogContent padding and keep the footer's inner spacing
        // consistent on all sides. The pseudo-element masks the scrollbar gutter.
        "relative mt-4 sticky bottom-0 z-10 rounded-b-lg border-t bg-background px-4 py-3 shadow-[0_-1px_0_0_hsl(var(--border)),0_-12px_24px_-24px_hsl(var(--foreground)/0.3)] [&>*]:relative [&>*]:z-10 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A low-level form wrapper for dialog content that enables Enter key submission.
 *
 * Wrap your dialog body and footer inside `<DialogForm onSubmit={handler}>` to
 * allow pressing Enter to trigger the primary action. The primary action button
 * should use `type="submit"` and cancel/secondary buttons should use `type="button"`.
 *
 * Prefer `StandardFormDialog` for standard product dialogs so consumers do not
 * need to assemble header/body/footer pieces by hand.
 *
 * @example
 * ```tsx
 * <DialogContent>
 *   <DialogHeader>...</DialogHeader>
 *   <DialogForm onSubmit={handleSave}>
 *     <Input ... />
 *     <DialogFooter>
 *       <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
 *       <Button type="submit">Save</Button>
 *     </DialogFooter>
 *   </DialogForm>
 * </DialogContent>
 * ```
 */
function DialogForm({
  className,
  onSubmit,
  ...props
}: React.ComponentProps<"form"> & {
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form
      data-slot="dialog-form"
      className={cn("contents", className)}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(e);
      }}
      {...props}
    />
  );
}

export {
  DialogBody,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogStickyFooter,
  DialogTitle,
  DialogTrigger,
};
