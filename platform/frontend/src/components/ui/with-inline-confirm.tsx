"use client";

import { Trash2 } from "lucide-react";
import {
  cloneElement,
  isValidElement,
  type ReactElement,
  useRef,
  useState,
} from "react";
import { Button } from "./button";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

interface WithInlineConfirmProps {
  children: ReactElement<{
    onClick?: (e: React.MouseEvent) => void;
    onPointerLeave?: (e: React.PointerEvent) => void;
    className?: string;
  }>;
  onConfirm?: () => void;
  confirmText?: string;
  cancelText?: string;
  /**
   * When true, replaces the trigger with confirm/cancel buttons inline
   * instead of showing a popover. Better UX as no mouse movement needed.
   */
  replaceMode?: boolean;
  /**
   * Called when the confirm state changes (useful for hiding sibling elements)
   */
  onOpenChange?: (open: boolean) => void;
}

export function WithInlineConfirm({
  children,
  onConfirm,
  confirmText = "Delete",
  cancelText = "Cancel",
  replaceMode = false,
  onOpenChange,
}: WithInlineConfirmProps) {
  const [open, setOpen] = useState(false);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Notify parent when open state changes
  const updateOpen = (newOpen: boolean) => {
    setOpen(newOpen);
    onOpenChange?.(newOpen);
  };

  const clearCloseTimeout = () => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  };

  const scheduleClose = () => {
    clearCloseTimeout();
    closeTimeoutRef.current = setTimeout(() => updateOpen(false), 100);
  };

  const handleConfirm = (e: React.MouseEvent) => {
    e.stopPropagation();
    clearCloseTimeout();
    updateOpen(false);
    if (onConfirm) {
      onConfirm();
    } else if (isValidElement(children) && children.props.onClick) {
      children.props.onClick({} as React.MouseEvent);
    }
  };

  const handleCancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    clearCloseTimeout();
    updateOpen(false);
  };

  const handleTriggerClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    clearCloseTimeout();
    updateOpen(true);
  };

  const handleContentClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  if (!isValidElement(children)) {
    return children;
  }

  // Replace mode: show inline confirm button in place of trigger
  if (replaceMode) {
    if (open) {
      return (
        <Button
          type="button"
          size="sm"
          variant="destructive"
          className="h-6 px-1.5 text-xs gap-1"
          onClick={handleConfirm}
          onPointerLeave={scheduleClose}
          onPointerEnter={clearCloseTimeout}
        >
          Confirm
          <Trash2 className="h-3 w-3" />
        </Button>
      );
    }

    return cloneElement(children, {
      onClick: handleTriggerClick,
      ...({ "data-confirm-open": undefined } as Record<string, unknown>),
    });
  }

  // Original popover mode
  const triggerElement = cloneElement(children, {
    onClick: handleTriggerClick,
    onPointerLeave: scheduleClose,
    ...({ "data-confirm-open": open ? "true" : undefined } as Record<
      string,
      unknown
    >),
  });

  return (
    <Popover open={open} onOpenChange={updateOpen}>
      <PopoverTrigger asChild>{triggerElement}</PopoverTrigger>
      <PopoverContent
        side="right"
        align="center"
        className="w-auto p-1"
        sideOffset={4}
        onClick={handleContentClick}
        onPointerEnter={clearCloseTimeout}
        onPointerLeave={scheduleClose}
      >
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="default"
            className="h-7 px-2 text-xs"
            onClick={handleConfirm}
          >
            {confirmText}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={handleCancel}
          >
            {cancelText}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
