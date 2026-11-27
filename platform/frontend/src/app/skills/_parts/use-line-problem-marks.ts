import type { OnMount } from "@monaco-editor/react";
import { useCallback, useEffect, useState } from "react";
import styles from "./line-problem-marks.module.css";

type MountedEditor = {
  editor: Parameters<OnMount>[0];
  monaco: Parameters<OnMount>[1];
};

/**
 * Marks one line of a Monaco editor as invalid: the line is tinted and
 * underlined, the reason shows on hover, and the line is scrolled into view.
 * Pass the returned handler as the editor's `onMount`.
 *
 * `problem` is null when there is nothing to mark, which also clears a mark
 * made before. The caller decides how long a problem stands; this only draws
 * it.
 */
export function useLineProblemMarks(
  problem: { line: number; message: string } | null,
): OnMount {
  // In state, not a ref: an editor is remounted when the open file changes,
  // and the marks have to be drawn again on the new one.
  const [mounted, setMounted] = useState<MountedEditor | null>(null);

  useEffect(() => {
    if (!mounted || !problem) return;
    const { editor, monaco } = mounted;
    const model = editor.getModel();
    if (!model) return;
    // A line past the end is the last line's to carry.
    const line = Math.min(Math.max(problem.line, 1), model.getLineCount());
    monaco.editor.setModelMarkers(model, MARKER_OWNER, [
      {
        severity: monaco.MarkerSeverity.Error,
        message: problem.message,
        startLineNumber: line,
        endLineNumber: line,
        startColumn: 1,
        endColumn: model.getLineMaxColumn(line),
      },
    ]);
    const tint = editor.createDecorationsCollection([
      {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: styles.invalidLine,
          linesDecorationsClassName: styles.invalidLineEdge,
        },
      },
    ]);
    editor.revealLineInCenterIfOutsideViewport(line);
    return () => {
      // The editor may be gone already (another file was opened).
      if (model.isDisposed()) return;
      tint.clear();
      monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
    };
  }, [mounted, problem]);

  return useCallback<OnMount>(
    (editor, monaco) => setMounted({ editor, monaco }),
    [],
  );
}

/** Names these markers among a model's, so clearing them leaves the rest. */
const MARKER_OWNER = "line-problem";
