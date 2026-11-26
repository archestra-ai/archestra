import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  collectFileArguments,
  decodeInlineFile,
  FileInputError,
  holdsFileShapedUpload,
  redactFileArguments,
  redactFileShapedData,
  schemaDeclaresFileInput,
} from "./file-input";

const FILE_SCHEMA = {
  type: "object",
  "x-mcp-file": { accept: ["application/pdf"], maxSize: 100 },
  properties: {
    id: { type: "string" },
    mimeType: { type: "string" },
    size: { type: "integer" },
  },
};

const file = (overrides: Record<string, unknown> = {}) => ({
  id: "f1",
  mimeType: "application/pdf",
  size: 5,
  ...overrides,
});

describe("schemaDeclaresFileInput", () => {
  test("finds the marker anywhere in the schema", () => {
    expect(
      schemaDeclaresFileInput({
        type: "object",
        properties: { files: { type: "array", items: FILE_SCHEMA } },
      }),
    ).toBe(true);
    expect(
      schemaDeclaresFileInput({
        type: "object",
        properties: { name: { type: "string" } },
      }),
    ).toBe(false);
    expect(schemaDeclaresFileInput(null)).toBe(false);
  });
});

describe("collectFileArguments", () => {
  test("follows properties, array items and anyOf branches", () => {
    const schema = {
      type: "object",
      properties: {
        cover: { anyOf: [FILE_SCHEMA, { type: "null" }] },
        attachments: { type: "array", items: FILE_SCHEMA },
        note: { type: "string" },
      },
    };
    const files = collectFileArguments(schema, {
      cover: file({ id: "cover" }),
      attachments: [file({ id: "a" }), file({ id: "b" })],
      note: "hi",
    });
    expect(files.map((f) => [f.path, f.input.id])).toEqual([
      [["cover"], "cover"],
      [["attachments", 0], "a"],
      [["attachments", 1], "b"],
    ]);
    expect(files[0].descriptor).toEqual({ maxSize: 100 });
  });

  test("an omitted optional file is not a file", () => {
    const schema = {
      type: "object",
      properties: { cover: { anyOf: [FILE_SCHEMA, { type: "null" }] } },
    };
    expect(collectFileArguments(schema, { cover: null })).toEqual([]);
    expect(collectFileArguments(schema, {})).toEqual([]);
    const fileOrUrl = {
      type: "object",
      properties: { cover: { anyOf: [FILE_SCHEMA, { type: "string" }] } },
    };
    expect(
      collectFileArguments(fileOrUrl, { cover: "https://example.com/a.pdf" }),
    ).toEqual([]);
    const objectAlternatives = {
      anyOf: [
        { type: "object", properties: { cover: FILE_SCHEMA } },
        { type: "object", properties: { cover: { type: "string" } } },
      ],
    };
    expect(
      collectFileArguments(objectAlternatives, { cover: "a.pdf" }),
    ).toEqual([]);
    const fileOrLink = {
      type: "object",
      properties: {
        cover: {
          oneOf: [
            FILE_SCHEMA,
            { type: "object", properties: { href: { type: "string" } } },
          ],
        },
      },
    };
    expect(
      collectFileArguments(fileOrLink, { cover: { href: "https://x/a.pdf" } }),
    ).toEqual([]);
  });

  test("refuses duplicate ids, invalid file inputs and a marked root", () => {
    const schema = {
      type: "object",
      properties: { a: FILE_SCHEMA, b: FILE_SCHEMA },
    };
    expect(() =>
      collectFileArguments(schema, { a: file(), b: file() }),
    ).toThrow(/share the id "f1"/);
    expect(() =>
      collectFileArguments(schema, { a: file({ size: -1 }) }),
    ).toThrow(FileInputError);
    expect(() =>
      collectFileArguments(schema, { a: file({ id: "x".repeat(129) }) }),
    ).toThrow(/1 to 128/);
    expect(() =>
      collectFileArguments(schema, { a: file({ data: null }) }),
    ).toThrow(/data that is not a string/);
    expect(() => collectFileArguments(schema, { a: "report.pdf" })).toThrow(
      /not a file input object/,
    );
    expect(() => collectFileArguments(schema, { a: [file()] })).toThrow(
      /not a file input object/,
    );
    expect(() =>
      collectFileArguments(
        { ...FILE_SCHEMA, properties: { ...FILE_SCHEMA.properties } },
        file(),
      ),
    ).toThrow(/whole input schema/);
  });
});

describe("decodeInlineFile", () => {
  const bytes = Buffer.from("hello");
  const digest = {
    algorithm: "sha-256" as const,
    value: createHash("sha256").update(bytes).digest("base64url"),
  };

  test("returns the bytes when size and digest match", () => {
    expect(
      decodeInlineFile(file({ data: bytes.toString("base64"), digest }), {}),
    ).toEqual(bytes);
  });

  test("an out-of-band file has no bytes to check", () => {
    expect(decodeInlineFile(file(), {})).toBeUndefined();
  });

  test("refuses data that is not base64, the wrong length, or the wrong digest", () => {
    expect(() => decodeInlineFile(file({ data: "aGVsbG8*" }), {})).toThrow(
      /not base64/,
    );
    expect(() => decodeInlineFile(file({ data: "aGk=" }), {})).toThrow(
      /decodes to 2/,
    );
    expect(() =>
      decodeInlineFile(
        file({
          data: Buffer.from("jello").toString("base64"),
          digest,
        }),
        {},
      ),
    ).toThrow(/sha-256 digest/);
  });

  test("refuses a file larger than the argument's maxSize, inline or not", () => {
    expect(() =>
      decodeInlineFile(file({ size: 101 }), { maxSize: 100 }),
    ).toThrow(/at most 100/);
  });

  test("checks an empty file's digest", () => {
    expect(() => decodeInlineFile(file({ size: 0, digest }), {})).toThrow(
      /sha-256 digest/,
    );
  });
});

describe("redaction", () => {
  const schema = { type: "object", properties: { doc: FILE_SCHEMA } };

  test("replaces inline data with its size and leaves the original intact", () => {
    const doc: Record<string, unknown> = file({ data: "aGVsbG8=" });
    const args = { doc, other: 1 };
    expect(redactFileArguments(schema, args)).toEqual({
      doc: { ...file(), data: "[5 bytes omitted]" },
      other: 1,
    });
    expect(args.doc.data).toBe("aGVsbG8=");
  });

  test("redacts data at a marked location even when it is no valid file", () => {
    const args = { doc: { id: 42, size: 5, data: "aGVsbG8=" }, data: "keep" };
    expect(redactFileArguments(schema, args)).toEqual({
      doc: { id: 42, size: 5, data: "[5 bytes omitted]" },
      data: "keep",
    });
    expect(args.doc.data).toBe("aGVsbG8=");
  });

  test("redacts file-shaped values without a schema", () => {
    expect(
      redactFileShapedData({ list: [file({ data: "aGVsbG8=" })], text: "x" }),
    ).toEqual({ list: [{ ...file(), data: "[5 bytes omitted]" }], text: "x" });
  });
});

describe("holdsFileShapedUpload", () => {
  test("finds a non-empty file without data anywhere", () => {
    expect(holdsFileShapedUpload({ a: [{ b: file() }] })).toBe(true);
    expect(holdsFileShapedUpload({ a: file({ data: "aGVsbG8=" }) })).toBe(
      false,
    );
    expect(holdsFileShapedUpload({ a: file({ size: 0 }) })).toBe(false);
    expect(holdsFileShapedUpload({ a: "x" })).toBe(false);
  });
});
