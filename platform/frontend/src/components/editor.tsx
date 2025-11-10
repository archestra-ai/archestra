"use client";

import { type EditorProps, Editor as MonacoEditor } from "@monaco-editor/react";
import { useTheme } from "next-themes";

interface CustomEditorProps extends Omit<EditorProps, "theme"> {
  /**
   * Override the automatic theme detection
   */
  theme?: "light" | "vs-dark" | "hc-black";
}

export function Editor({ theme: customTheme, ...props }: CustomEditorProps) {
  const { resolvedTheme } = useTheme();
  return (
    <MonacoEditor
      theme={customTheme || (resolvedTheme === "dark" ? "vs-dark" : "light")}
      {...props}
    />
  );
}
