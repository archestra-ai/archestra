import type { DiffOnMount } from "@monaco-editor/react";
import styles from "./policy-diff-review.module.css";

type DiffEditor = Parameters<DiffOnMount>[0];
type LineChange = NonNullable<ReturnType<DiffEditor["getLineChanges"]>>[number];

/** Inline deletions are view zones, so model decorations alone cannot mark them. */
export function createPolicyDiffHighlight(
  editor: DiffEditor,
  monaco: Parameters<DiffOnMount>[1],
  isSideBySide: () => boolean,
) {
  const original = editor.getOriginalEditor();
  const modified = editor.getModifiedEditor();
  const markers = {
    original: original.createDecorationsCollection(),
    modified: modified.createDecorationsCollection(),
  };
  const deletedMarker = document.createElement("div");
  deletedMarker.className = styles.activeDeletedChange;
  deletedMarker.setAttribute("aria-hidden", "true");
  let current: LineChange | undefined;
  let frame: number | null = null;
  let top = 0;
  let left = 0;
  const widget = {
    getId: () => "policy-diff-current-deletion",
    getDomNode: () => deletedMarker,
    getPosition: () => ({ preference: { top, left } }),
  };
  modified.addOverlayWidget(widget);

  function renderDeletedMarker() {
    frame = null;
    if (!current || !current.originalEndLineNumber || isSideBySide()) {
      deletedMarker.style.display = "none";
      return;
    }
    // Monaco aligns the hidden original editor with the removed-line view
    // zones in unified mode. Its public line geometry gives their exact bounds,
    // including folded regions, without inspecting Monaco's generated DOM.
    const start =
      original.getTopForLineNumber(current.originalStartLineNumber) -
      original.getScrollTop();
    const end =
      original.getBottomForLineNumber(current.originalEndLineNumber) -
      original.getScrollTop();
    const layout = modified.getLayoutInfo();
    top = Math.max(0, start);
    const bottom = Math.min(
      layout.height - layout.horizontalScrollbarHeight,
      end,
    );
    left = layout.decorationsLeft + 3;
    deletedMarker.style.display = bottom > top ? "block" : "none";
    deletedMarker.style.height = `${Math.max(0, bottom - top)}px`;
    modified.layoutOverlayWidget(widget);
  }

  function scheduleRender() {
    if (frame === null) frame = requestAnimationFrame(renderDeletedMarker);
  }

  const subscriptions = [original, modified].flatMap((pane) => [
    pane.onDidScrollChange(scheduleRender),
    pane.onDidLayoutChange(scheduleRender),
    pane.onDidContentSizeChange(scheduleRender),
  ]);

  return {
    select(change: LineChange | undefined, index: number, total: number) {
      current = change;
      for (const pane of ["original", "modified"] as const) {
        // end=0 means this side is empty. The start is only a navigation
        // anchor; decorating it would highlight an unchanged line.
        if (!change || !change[`${pane}EndLineNumber`]) {
          markers[pane].clear();
          continue;
        }
        markers[pane].set([
          {
            range: new monaco.Range(
              change[`${pane}StartLineNumber`],
              1,
              change[`${pane}EndLineNumber`],
              1,
            ),
            options: {
              isWholeLine: true,
              linesDecorationsClassName: styles.activeChange,
              linesDecorationsTooltip: `Change ${index + 1} of ${total}`,
            },
          },
        ]);
      }
      scheduleRender();
    },
    dispose() {
      if (frame !== null) cancelAnimationFrame(frame);
      for (const subscription of subscriptions) subscription.dispose();
      modified.removeOverlayWidget(widget);
      markers.original.clear();
      markers.modified.clear();
    },
  };
}
