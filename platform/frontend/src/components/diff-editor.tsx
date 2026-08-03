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
        readOnly: true,
        // A unified diff fits the dialog's narrow preview pane; side-by-side
        // would halve the usable width for each revision.
        renderSideBySide: false,
        // Long, mostly-unchanged SKILL.md bodies collapse to the edited
        // regions, so a one-line change does not require scrolling past
        // everything that stayed the same.
        hideUnchangedRegions: { enabled: true },
        scrollBeyondLastLine: false,
        minimap: { enabled: false },
        ...options,
      }}
      {...props}
    />
  );
}
