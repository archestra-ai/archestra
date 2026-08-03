"use client";

import {
  type DiffEditorProps,
  DiffEditor as MonacoDiffEditor,
} from "@monaco-editor/react";
import { useTheme } from "next-themes";

interface CustomDiffEditorProps extends Omit<DiffEditorProps, "theme"> {
  /**
   * Override the automatic theme detection
   */
  theme?: "light" | "vs-dark" | "hc-black";
}

export function DiffEditor({
  theme: customTheme,
  options,
  ...props
}: CustomDiffEditorProps) {
  const { resolvedTheme } = useTheme();
  return (
    <MonacoDiffEditor
      theme={customTheme || (resolvedTheme === "dark" ? "vs-dark" : "light")}
      options={{
        // Tab/Shift+Tab move focus out of the editor instead of inserting a
        // tab character, so keyboard users are not trapped inside embedded
        // editors (WCAG 2.1.2). Ctrl+M / Ctrl+Shift+M toggles it back.
        tabFocusMode: true,
        // A diff of two stored revisions is a view, never an edit surface.
        readOnly: true,
        scrollBeyondLastLine: false,
        minimap: { enabled: false },
        ...options,
      }}
      {...props}
    />
  );
}
