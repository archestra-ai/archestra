"use client";

import type { DiffOnMount } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import { createPolicyDiffHighlight } from "./policy-diff-highlight";

type DiffEditor = Parameters<DiffOnMount>[0];
type LineChange = NonNullable<ReturnType<DiffEditor["getLineChanges"]>>[number];
type Pane = "original" | "modified";

/** Track the change being read, independently of Monaco's editor cursor. */
export function usePolicyDiffNavigation(sideBySide: boolean) {
  const [mounted, setMounted] = useState<Parameters<DiffOnMount> | null>(null);
  const [position, setPosition] = useState({
    ready: false,
    current: 0,
    total: 0,
  });
  const moveRef = useRef<(offset: number) => void>(() => {});
  const changeViewRef = useRef<(update: () => void) => void>((update) =>
    update(),
  );
  const sideBySideRef = useRef(sideBySide);

  useEffect(() => {
    sideBySideRef.current = sideBySide;
  }, [sideBySide]);

  useEffect(() => {
    if (!mounted) return;
    const [editor, monaco] = mounted;
    const original = editor.getOriginalEditor();
    const modified = editor.getModifiedEditor();
    const highlight = createPolicyDiffHighlight(
      editor,
      monaco,
      () => sideBySideRef.current,
    );
    let changes: LineChange[] = [];
    let current = -1;
    let navigating = false;
    let userScrolling = false;
    let layoutFrame: number | null = null;
    let navigationFrame: number | null = null;

    function pauseScrollTracking() {
      navigating = true;
      userScrolling = false;
      if (navigationFrame !== null) cancelAnimationFrame(navigationFrame);
      navigationFrame = requestAnimationFrame(() => {
        navigationFrame = null;
        navigating = false;
      });
    }

    function range(change: LineChange, pane: Pane) {
      const start = Math.max(1, change[`${pane}StartLineNumber`]);
      // An empty side uses end=0 and start=the preceding line (also 0 at
      // the start of a file). Keep the deletion/insertion anchor in view.
      return {
        start,
        end: Math.max(start, change[`${pane}EndLineNumber`]),
      };
    }

    function select(index: number) {
      current = index;
      setPosition({ ready: true, current: index + 1, total: changes.length });
      highlight.select(changes[index], index, changes.length);
    }

    function reveal(index: number, line?: number) {
      if (index < 0 || index >= changes.length) return;
      pauseScrollTracking();
      select(index);
      const start = line ?? range(changes[index], "modified").start;
      modified.setPosition({ lineNumber: start, column: 1 });
      modified.revealLineNearTop(start, monaco.editor.ScrollType.Immediate);
    }

    function nearest(line: number, pane: Pane) {
      let index = -1;
      let distance = Number.POSITIVE_INFINITY;
      changes.forEach((change, i) => {
        const { start, end } = range(change, pane);
        const gap = Math.max(start - line, line - end, 0);
        if (gap < distance) {
          index = i;
          distance = gap;
        }
      });
      return index;
    }

    function followScroll() {
      if (navigating || !userScrolling || !changes.length) return;
      const visible = modified.getVisibleRanges();
      if (!visible.length) return;
      const isVisible = (change: LineChange) => {
        const { start, end } = range(change, "modified");
        return visible.some(
          (part) => start <= part.endLineNumber && end >= part.startLineNumber,
        );
      };
      // Manual scrolling follows the first visible change. Button/search
      // navigation pauses this listener while revealing its exact target.
      const firstVisible = changes.findIndex(isVisible);
      const index =
        firstVisible >= 0
          ? firstVisible
          : nearest(visible[0].startLineNumber, "modified");
      if (index !== current) select(index);
    }

    function updateChanges() {
      const computed = editor.getLineChanges();
      if (computed === null) return;
      const firstComputation = current === -1;
      changes = computed;
      if (!changes.length) {
        select(-1);
      } else if (firstComputation) {
        reveal(0);
      } else {
        select(Math.min(current, changes.length - 1));
        followScroll();
      }
    }

    moveRef.current = (offset) => reveal(current + offset);
    changeViewRef.current = (update) => {
      const selected = current;
      const top = modified.getVisibleRanges()[0]?.startLineNumber;
      const active = changes[selected]
        ? range(changes[selected], "modified")
        : null;
      const anchor =
        active && top !== undefined && top >= active.start && top <= active.end
          ? top
          : undefined;
      navigating = true;
      userScrolling = false;
      if (navigationFrame !== null) cancelAnimationFrame(navigationFrame);
      update();
      if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
      // A view-mode switch recalculates scroll offsets. Keep the selected
      // change instead of treating that layout scroll as user navigation.
      layoutFrame = requestAnimationFrame(() => {
        layoutFrame = null;
        reveal(selected, anchor);
        if (selected < 0) navigating = false;
      });
    };
    const container = editor.getContainerDomNode();
    const startScrolling = () => {
      userScrolling = true;
    };
    // Monaco also scrolls when find closes or the layout changes. Only actual
    // scrolling gestures should replace the selected change with the top one.
    container.addEventListener("wheel", startScrolling, {
      capture: true,
      passive: true,
    });
    container.addEventListener("touchmove", startScrolling, {
      capture: true,
      passive: true,
    });
    const subscriptions = [
      editor.onDidUpdateDiff(updateChanges),
      modified.onDidLayoutChange(() => changeViewRef.current(() => {})),
      modified.onMouseDown((event) => {
        if (event.target.type === monaco.editor.MouseTargetType.SCROLLBAR)
          startScrolling();
      }),
      ...[original, modified].map((pane) =>
        pane.onKeyDown((event) => {
          if (
            [
              monaco.KeyCode.UpArrow,
              monaco.KeyCode.DownArrow,
              monaco.KeyCode.PageUp,
              monaco.KeyCode.PageDown,
              monaco.KeyCode.Home,
              monaco.KeyCode.End,
            ].includes(event.keyCode)
          )
            startScrolling();
        }),
      ),
      modified.onDidScrollChange((event) => {
        if (
          event.scrollTopChanged &&
          !event.scrollHeightChanged &&
          !event.scrollWidthChanged
        )
          followScroll();
      }),
      ...(["original", "modified"] as const).map((pane) =>
        (pane === "original" ? original : modified).onDidChangeCursorPosition(
          (event) => {
            if (navigating || !changes.length) return;
            const index = nearest(event.position.lineNumber, pane);
            if (index !== current) select(index);
            pauseScrollTracking();
          },
        ),
      ),
    ];
    updateChanges();
    return () => {
      moveRef.current = () => {};
      changeViewRef.current = (update) => update();
      if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
      if (navigationFrame !== null) cancelAnimationFrame(navigationFrame);
      container.removeEventListener("wheel", startScrolling, true);
      container.removeEventListener("touchmove", startScrolling, true);
      for (const subscription of subscriptions) subscription.dispose();
      highlight.dispose();
    };
  }, [mounted]);

  return {
    ...position,
    onMount: ((editor, monaco) => setMounted([editor, monaco])) as DiffOnMount,
    move: (offset: number) => moveRef.current(offset),
    changeView: (update: () => void) => changeViewRef.current(update),
  };
}
