"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
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
  !!event.dataTransfer?.types?.includes("Files");

/**
 * Wraps a region so dragging OS files onto it triggers an upload. Only reacts to
 * file drags (ignores text/element drags), and uses a depth counter so the
 * overlay doesn't flicker as the pointer moves between nested children.
 *
 * Listeners are attached natively (not via React's synthetic events) because a
 * file drag inside the zone must be *claimed* with `stopPropagation` so it never
 * reaches a document-level drop listener elsewhere on the page (e.g. the chat
 * composer's `globalDrop`, which would otherwise also attach the dropped file).
 * React's synthetic `stopPropagation` does NOT stop a native `document` listener;
 * a native bubble-phase `stopPropagation` does. The claim happens even while
 * `disabled` (which only suppresses the overlay and the upload), so an in-flight
 * upload can't leak a second drop to the composer.
 */
export function FileDropZone({
  onDropFiles,
  disabled,
  className,
  children,
}: FileDropZoneProps) {
  const [dragActive, setDragActive] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Read the latest props inside once-bound native listeners without rebinding.
  const onDropFilesRef = useRef(onDropFiles);
  onDropFilesRef.current = onDropFiles;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let depth = 0;

    const onDragEnter = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (disabledRef.current) return;
      depth += 1;
      setDragActive(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      // Required for the drop to fire and to show the copy cursor.
      event.preventDefault();
      event.stopPropagation();
    };
    const onDragLeave = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (disabledRef.current) return;
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        setDragActive(false);
      }
    };
    const onDrop = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth = 0;
      setDragActive(false);
      if (disabledRef.current) return;
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) onDropFilesRef.current(files);
    };

    el.addEventListener("dragenter", onDragEnter);
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragenter", onDragEnter);
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("dragleave", onDragLeave);
      el.removeEventListener("drop", onDrop);
    };
  }, []);

  return (
    <div ref={containerRef} className={cn("relative", className)}>
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
