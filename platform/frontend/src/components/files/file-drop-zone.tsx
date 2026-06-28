"use client";

import type { DragEvent, ReactNode } from "react";
import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface FileDropZoneProps {
  /** Called with the dropped files (never empty). */
  onDropFiles: (files: File[]) => void;
  /** When true, drags are ignored and no overlay is shown. */
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

const isFileDrag = (event: DragEvent) =>
  event.dataTransfer.types.includes("Files");

/**
 * Wraps a region so dragging OS files onto it triggers an upload. Only reacts to
 * file drags (ignores text/element drags), and uses a depth counter so the
 * overlay doesn't flicker as the pointer moves between nested children.
 *
 * A file drag inside the zone is always *claimed* (preventDefault +
 * stopPropagation) — even while `disabled` — so it never reaches a global
 * document-level drop listener elsewhere on the page (e.g. the chat composer's
 * `globalDrop`, which would otherwise also attach the dropped file). `disabled`
 * only suppresses the overlay and the upload, not the claim.
 */
export function FileDropZone({
  onDropFiles,
  disabled,
  className,
  children,
}: FileDropZoneProps) {
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);

  const handleDragEnter = useCallback(
    (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (disabled) return;
      dragDepth.current += 1;
      setDragActive(true);
    },
    [disabled],
  );

  const handleDragOver = useCallback((event: DragEvent) => {
    if (!isFileDrag(event)) return;
    // Required for the drop to fire and to show the copy cursor.
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleDragLeave = useCallback(
    (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (disabled) return;
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) {
        dragDepth.current = 0;
        setDragActive(false);
      }
    },
    [disabled],
  );

  const handleDrop = useCallback(
    (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepth.current = 0;
      setDragActive(false);
      if (disabled) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) onDropFiles(files);
    },
    [disabled, onDropFiles],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: file drag-and-drop has no keyboard equivalent; the handlers don't make this a control.
    <div
      className={cn("relative", className)}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-primary bg-primary/10">
          <p className="text-sm font-medium text-primary">
            Drop files to upload
          </p>
        </div>
      )}
    </div>
  );
}
