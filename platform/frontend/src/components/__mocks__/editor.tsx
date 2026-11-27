/**
 * Jest-style mock for `@/components/editor`, activated per test file by a
 * bare `vi.mock("@/components/editor");`. Monaco does not render in jsdom, so
 * the editor is a plain textarea carrying the props a test reads and types
 * into: `value`/`onChange`, and the accessible name, placeholder and
 * read-only state it would have had (`options.ariaLabel`,
 * `options.placeholder`, `options.readOnly`).
 *
 * `onMount` is called once with a stand-in for the editor instance that
 * answers only what the app's own editors ask of it: a content height of
 * {@link MOCK_EDITOR_LINE_HEIGHT_PX} per line of the value (plus padding),
 * focus, a content-size subscription that fires when the value changes —
 * which is what an editor sized by its content is listening for — and a
 * decorations collection that holds what it is given. The Monaco namespace
 * it is handed with accepts a link provider and a link opener and calls
 * neither: jsdom draws no links to follow. jsdom paints no glyph
 * margin, so the decorations are only kept, never drawn; what goes into them
 * is tested where it is computed. A view zone, the block an editor draws
 * between two lines, is put after the textarea, so what it holds can be read.
 * Markers, the errors an editor underlines, are kept as JSON in the
 * textarea's `data-markers`, since which line is marked is what a test asks.
 */
import type { EditorProps } from "@monaco-editor/react";
import { useEffect, useRef } from "react";

const MOCK_EDITOR_LINE_HEIGHT_PX = 20;
const MOCK_EDITOR_PADDING_PX = 16;

export function Editor({
  value,
  onChange,
  onMount,
  options,
  height,
  language,
  defaultLanguage,
}: Pick<
  EditorProps,
  | "value"
  | "onChange"
  | "onMount"
  | "options"
  | "height"
  | "language"
  | "defaultLanguage"
>) {
  const valueRef = useRef(value ?? "");
  valueRef.current = value ?? "";
  const onMountRef = useRef(onMount);
  onMountRef.current = onMount;
  const contentSizeListeners = useRef(new Set<() => void>());
  const zones = useRef(new Map<string, HTMLElement>());
  const zoneHost = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const editor = {
      getContentHeight: () =>
        valueRef.current.split("\n").length * MOCK_EDITOR_LINE_HEIGHT_PX +
        MOCK_EDITOR_PADDING_PX,
      onDidContentSizeChange: (listener: () => void) => {
        contentSizeListeners.current.add(listener);
        return { dispose: () => contentSizeListeners.current.delete(listener) };
      },
      focus: () => {},
      getValue: () => valueRef.current,
      getModel: () => ({
        getLineCount: () => valueRef.current.split("\n").length,
        getLineMaxColumn: (line: number) =>
          (valueRef.current.split("\n")[line - 1]?.length ?? 0) + 1,
        isDisposed: () => false,
      }),
      addCommand: () => null,
      changeViewZones: (
        change: (accessor: {
          addZone: (zone: { domNode: HTMLElement }) => string;
          removeZone: (id: string) => void;
          layoutZone: (id: string) => void;
        }) => void,
      ) =>
        change({
          addZone: (zone) => {
            const id = `zone-${zones.current.size + 1}-${Math.random()}`;
            zones.current.set(id, zone.domNode);
            zoneHost.current?.appendChild(zone.domNode);
            return id;
          },
          removeZone: (id) => {
            zones.current.get(id)?.remove();
            zones.current.delete(id);
          },
          layoutZone: () => {},
        }),
      // A line is revealed and marked, never drawn: jsdom scrolls nothing.
      revealLineInCenter: () => {},
      revealLineInCenterIfOutsideViewport: () => {},
      setPosition: () => {},
      onMouseDown: () => ({ dispose: () => {} }),
      onDidChangeCursorPosition: () => ({ dispose: () => {} }),
      createDecorationsCollection: (initial: unknown[] = []) => {
        let held = initial;
        return {
          set: (next: unknown[]) => {
            held = next;
          },
          clear: () => {
            held = [];
          },
          get length() {
            return held.length;
          },
        };
      },
    } as unknown as Parameters<NonNullable<EditorProps["onMount"]>>[0];
    const disposable = { dispose: () => {} };
    const monaco = {
      languages: { registerLinkProvider: () => disposable },
      editor: {
        registerLinkOpener: () => disposable,
        MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
        setModelMarkers: (_model: unknown, _owner: string, next: unknown[]) => {
          if (!textarea.current) return;
          if (next.length === 0) delete textarea.current.dataset.markers;
          else textarea.current.dataset.markers = JSON.stringify(next);
        },
      },
      MarkerSeverity: { Error: 8 },
      Range: class {
        constructor(
          readonly startLineNumber: number,
          readonly startColumn: number,
          readonly endLineNumber: number,
          readonly endColumn: number,
        ) {}
      },
      KeyMod: { CtrlCmd: 2048 },
      KeyCode: { Enter: 3, KeyS: 49 },
    } as unknown as Parameters<NonNullable<EditorProps["onMount"]>>[1];
    onMountRef.current?.(editor, monaco);
  }, []);
  // Monaco reports a new content size as the text grows; a host that sizes
  // itself from it sees nothing at all without this. `value` is the content
  // size here, so it is the dependency even though the effect only reads a
  // ref — hence the explicit read.
  useEffect(() => {
    void value;
    for (const listener of contentSizeListeners.current) listener();
  }, [value]);
  return (
    <>
      <textarea
        ref={textarea}
        data-testid="editor"
        data-height={height}
        data-language={language ?? defaultLanguage}
        aria-label={options?.ariaLabel}
        placeholder={options?.placeholder}
        readOnly={options?.readOnly}
        value={value ?? ""}
        onChange={(event) => onChange?.(event.target.value, undefined as never)}
      />
      <div ref={zoneHost} data-testid="editor-zones" />
    </>
  );
}
