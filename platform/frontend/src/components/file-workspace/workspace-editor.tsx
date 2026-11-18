"use client";

import type { ComponentProps } from "react";
import { Editor } from "@/components/editor";
import { cn } from "@/lib/utils/tailwind";

type EditorProps = ComponentProps<typeof Editor>;

/**
 * The open file of a file workspace, in a Monaco editor that fills the box it
 * is given. The options are the workspace's defaults; a caller's win.
 */
export function WorkspaceEditor({
  className,
  options,
  ...props
}: Omit<EditorProps, "height"> & { className?: string }) {
  return (
    // Monaco measures its parent, so the editor sits in a box of its own
    // that takes the pane's size without growing it.
    <div className={cn("relative min-h-60", className)}>
      <div className="absolute inset-0">
        <Editor
          height="100%"
          {...props}
          options={{ ...WORKSPACE_EDITOR_OPTIONS, ...options }}
        />
      </div>
    </div>
  );
}

const WORKSPACE_EDITOR_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 13,
  lineNumbers: "on",
  // Monaco reserves five digits and a wide decorations lane by default, which
  // ate a quarter of a phone's width; the gutter still grows past 999 lines.
  lineNumbersMinChars: 3,
  lineDecorationsWidth: 6,
  scrollBeyondLastLine: false,
  wordWrap: "on",
  padding: { top: 8, bottom: 8 },
  automaticLayout: true,
  scrollbar: { alwaysConsumeMouseWheel: false },
} satisfies EditorProps["options"];
