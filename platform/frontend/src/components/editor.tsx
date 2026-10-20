"use client";

import { type EditorProps, Editor as MonacoEditor } from "@monaco-editor/react";
import { useTheme } from "next-themes";

interface CustomEditorProps extends Omit<EditorProps, "theme"> {
  /**
   * Override the automatic theme detection
   */
  theme?: "light" | "vs-dark" | "hc-black";
  /**
   * Custom themes, defined in `beforeMount`, to follow the app theme with
   * instead of the built-in ones (e.g. a language's own token colours).
   */
  themes?: { dark: string; light: string };
}

export function Editor({
  theme: customTheme,
  themes,
  options,
  ...props
}: CustomEditorProps) {
  const { resolvedTheme } = useTheme();
  return (
    <MonacoEditor
      theme={
        customTheme ||
        (resolvedTheme === "dark"
          ? (themes?.dark ?? "vs-dark")
          : (themes?.light ?? "light"))
      }
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
