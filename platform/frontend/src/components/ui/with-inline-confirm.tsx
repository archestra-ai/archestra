"use client";

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
}

export function WithInlineConfirm({
  children,
  onConfirm,
  confirmText = "Delete",
  cancelText = "Cancel",
}: WithInlineConfirmProps) {
  const [open, setOpen] = useState(false);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCloseTimeout = () => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  };

  const scheduleClose = () => {
    clearCloseTimeout();
    closeTimeoutRef.current = setTimeout(() => setOpen(false), 100);
  };

  const handleConfirm = (e: React.MouseEvent) => {
    e.stopPropagation();
    clearCloseTimeout();
    setOpen(false);
    if (onConfirm) {
      onConfirm();
    } else if (isValidElement(children) && children.props.onClick) {
      children.props.onClick({} as React.MouseEvent);
    }
  };

  const handleCancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    clearCloseTimeout();
    setOpen(false);
  };

  const handleTriggerClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    clearCloseTimeout();
    setOpen(true);
  };

  const handleContentClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  if (!isValidElement(children)) {
    return children;
  }

  const triggerElement = cloneElement(children, {
    onClick: handleTriggerClick,
    onPointerLeave: scheduleClose,
    ...({ "data-confirm-open": open ? "true" : undefined } as Record<
      string,
      unknown
    >),
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
