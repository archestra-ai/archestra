"use client";

import {
  type DiffEditorProps,
  type DiffOnMount,
  DiffEditor as MonacoDiffEditor,
} from "@monaco-editor/react";
import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";

type DiffEditorInstance = Parameters<DiffOnMount>[0];

// The model path props are deliberately not part of this component's API: a
// path makes Monaco look the pair up by URI and share it across every editor
// on that path, which the unmount disposal below would pull out from under a
// sibling that is still rendering.
interface CustomDiffEditorProps
  extends Omit<
    DiffEditorProps,
    "theme" | "originalModelPath" | "modifiedModelPath"
  > {
  /**
   * Override the automatic theme detection
   */
  theme?: "light" | "vs-dark" | "hc-black";
}

export function DiffEditor({
  theme: customTheme,
  options,
  onMount,
  // Monaco disposes its text models on unmount by default, which the diff
  // widget's own model reset then races ("TextModel got disposed before
  // DiffEditorWidget model got reset") on every content switch and on close.
  keepCurrentOriginalModel = true,
  keepCurrentModifiedModel = true,
  ...props
}: CustomDiffEditorProps) {
  const { resolvedTheme } = useTheme();
  const editorRef = useRef<DiffEditorInstance>(null);

  // Keeping the models above means nothing else disposes them: a model is
  // created once per mount, and with no model path to look up, every mount
  // mints a new one rather than reusing it. Mounts are routine — closing the
  // dialog, toggling whole/changes, one per diffed section — so the pair has
  // to go somewhere. Read it off the widget at cleanup rather than caching it
  // at mount, so it is whichever pair is live now. React runs a parent's
  // cleanup before its children's, so the widget is still alive here and still
  // points at these models: reset it first, or disposing them is the very race
  // the flags above avoid.
  useEffect(
    () => () => {
      const models = editorRef.current?.getModel();
      editorRef.current?.setModel(null);
      models?.original.dispose();
      models?.modified.dispose();
      editorRef.current = null;
    },
    [],
  );

  return (
    <MonacoDiffEditor
      theme={customTheme || (resolvedTheme === "dark" ? "vs-dark" : "light")}
      keepCurrentOriginalModel={keepCurrentOriginalModel}
      keepCurrentModifiedModel={keepCurrentModifiedModel}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        onMount?.(editor, monaco);
      }}
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
