import { describe, expect, test } from "@/test";
import { unwrapToolContent } from "./unwrap-tool-content";

describe("unwrapToolContent", () => {
  test("unwraps stringified array with text block wrapper", () => {
    const wrapped = '[{"type":"text","text":"{\\"data\\":\\"value\\"}"}]';
    const result = unwrapToolContent(wrapped);
    expect(result).toBe('{"data":"value"}');
  });

  test("unwraps array object with text block wrapper", () => {
    const wrapped = [{ type: "text", text: '{"data":"value"}' }];
    const result = unwrapToolContent(wrapped);
    expect(result).toBe('{"data":"value"}');
  });

  test("returns plain JSON string unchanged", () => {
    const plain = '{"data":"value"}';
    const result = unwrapToolContent(plain);
    expect(result).toBe('{"data":"value"}');
  });

  test("returns non-JSON string unchanged", () => {
    const plain = "just plain text";
    const result = unwrapToolContent(plain);
    expect(result).toBe("just plain text");
  });

  test("handles empty array", () => {
    const empty = "[]";
    const result = unwrapToolContent(empty);
    expect(result).toBe("[]");
  });

  test("handles array without type:text", () => {
    const noType = '[{"foo":"bar"}]';
    const result = unwrapToolContent(noType);
    expect(result).toBe('[{"foo":"bar"}]');
  });

  test("handles array with type but no text field", () => {
    const noText = '[{"type":"text","content":"value"}]';
    const result = unwrapToolContent(noText);
    expect(result).toBe('[{"type":"text","content":"value"}]');
  });

  test("unwraps complex nested JSON", () => {
    const wrapped =
      '[{"type":"text","text":"{\\"issues\\":[{\\"id\\":123,\\"title\\":\\"Test\\"}]}"}]';
    const result = unwrapToolContent(wrapped);
    expect(result).toBe('{"issues":[{"id":123,"title":"Test"}]}');
  });

  test("handles object input (non-string)", () => {
    const obj = { data: "value" };
    const result = unwrapToolContent(obj);
    expect(result).toBe('{"data":"value"}');
  });

  test("unwraps when given as object array", () => {
    const wrapped = [{ type: "text", text: '{"issues":[{"id":123}]}' }];
    const result = unwrapToolContent(wrapped);
    expect(result).toBe('{"issues":[{"id":123}]}');
  });

  test("returns unwrapped content from multiple wrapper formats", () => {
    // String format
    const stringWrapped =
      '[{"type":"text","text":"{\\"temperature\\":20,\\"condition\\":\\"sunny\\"}"}]';
    expect(unwrapToolContent(stringWrapped)).toBe(
      '{"temperature":20,"condition":"sunny"}',
    );

    // Array format
    const arrayWrapped = [
      { type: "text", text: '{"temperature":20,"condition":"sunny"}' },
    ];
    expect(unwrapToolContent(arrayWrapped)).toBe(
      '{"temperature":20,"condition":"sunny"}',
    );
  });
});
