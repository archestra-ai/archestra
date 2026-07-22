"use client";

import { type EditorProps, Editor as MonacoEditor } from "@monaco-editor/react";
import { useTheme } from "next-themes";

interface CustomEditorProps extends Omit<EditorProps, "theme"> {
  /**
   * Override the automatic theme detection
   */
  theme?: "light" | "vs-dark" | "hc-black";
}

export function Editor({
  theme: customTheme,
  options,
  ...props
}: CustomEditorProps) {
  const { resolvedTheme } = useTheme();
  return (
    <MonacoEditor
      theme={customTheme || (resolvedTheme === "dark" ? "vs-dark" : "light")}
      options={{
        // Tab/Shift+Tab move focus out of the editor instead of inserting a
        // tab character, so keyboard users are not trapped inside embedded
        // editors (WCAG 2.1.2). Ctrl+M / Ctrl+Shift+M toggles it back for
        // indenting.
        tabFocusMode: true,
        ...options,
      }}
      {...props}
    />
  );
}
