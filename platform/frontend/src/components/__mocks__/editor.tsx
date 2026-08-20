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
 * {@link MOCK_EDITOR_LINE_HEIGHT_PX} per line of the value (plus padding), a
 * no-op content-size subscription, and focus.
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
  useEffect(() => {
    const editor = {
      getContentHeight: () =>
        valueRef.current.split("\n").length * MOCK_EDITOR_LINE_HEIGHT_PX +
        MOCK_EDITOR_PADDING_PX,
      onDidContentSizeChange: () => ({ dispose: () => {} }),
      focus: () => {},
      getValue: () => valueRef.current,
    } as unknown as Parameters<NonNullable<EditorProps["onMount"]>>[0];
    onMountRef.current?.(editor, {} as never);
  }, []);
  return (
    <textarea
      data-testid="editor"
      data-height={height}
      data-language={language ?? defaultLanguage}
      aria-label={options?.ariaLabel}
      placeholder={options?.placeholder}
      readOnly={options?.readOnly}
      value={value ?? ""}
      onChange={(event) => onChange?.(event.target.value, undefined as never)}
    />
  );
}
