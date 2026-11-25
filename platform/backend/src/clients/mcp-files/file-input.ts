import { createHash } from "node:crypto";
import { MCP_FILE_SCHEMA_KEYWORD } from "@archestra/shared";

/**
 * Tool arguments that carry files under the MCP File Uploads extension.
 *
 * A tool marks a file argument with `x-mcp-file` on the argument's object
 * schema. The value the client sends there is a {@link FileInput}: metadata
 * plus, for an inline transfer, the bytes as base64 in `data`. A non-empty
 * file without `data` asks the server for an out-of-band upload.
 *
 * @see https://github.com/modelcontextprotocol/experimental-ext-file-uploads
 */

export type FileInputDescriptor = {
  accept?: string[];
  maxSize?: number;
};

export type FileInputDigest = { algorithm: "sha-256"; value: string };

export type FileInput = {
  id: string;
  name?: string;
  mimeType: string;
  size: number;
  digest?: FileInputDigest;
  data?: string;
};

/** Where a file argument sits in the arguments object. */
export type FileArgumentPath = (string | number)[];

export type FileArgument = {
  path: FileArgumentPath;
  descriptor: FileInputDescriptor;
  input: FileInput;
  /** Decoded inline bytes; absent for an out-of-band or empty file. */
  bytes?: Buffer;
};

const MAX_FILE_INPUT_ID_LENGTH = 128;

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64URL_SHA256_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type JsonSchemaNode = Record<string, unknown>;

/**
 * Whether a tool's input schema marks any argument as a file, anywhere.
 *
 * Deliberately a plain deep scan rather than a schema walk: it decides whether
 * a tool is offered at all, so it must not miss a marker in a keyword the
 * argument walk below does not follow.
 */
export function schemaDeclaresFileInput(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(schemaDeclaresFileInput);
  if (!isObject(schema)) return false;
  if (MCP_FILE_SCHEMA_KEYWORD in schema) return true;
  return Object.values(schema).some(schemaDeclaresFileInput);
}

/**
 * Find every value in `args` that sits at an `x-mcp-file` schema.
 *
 * Follows the places the extension allows the marker: object `properties`,
 * array `items`, and `anyOf`/`oneOf`/`allOf` branches. A marked location
 * holding `null` or nothing is an omitted optional file, not a file.
 *
 * Throws {@link FileInputError} when a marked location holds a value that is
 * not a valid `FileInput`, or when two files share an id.
 */
export function collectFileArguments(
  schema: unknown,
  args: Record<string, unknown>,
): FileArgument[] {
  const found = new Map<string, FileArgument>();
  walk(schema, args, [], found);

  const files = [...found.values()];
  const ids = new Set<string>();
  for (const file of files) {
    if (ids.has(file.input.id)) {
      throw new FileInputError(
        `Two files share the id "${file.input.id}"; each file in a call needs its own id.`,
      );
    }
    ids.add(file.input.id);
  }
  return files;
}

/**
 * Check one file's inline bytes against what it declares.
 *
 * Returns the decoded bytes for an inline file, nothing for an out-of-band or
 * empty one. Throws {@link FileInputError} when the bytes do not match.
 */
export function decodeInlineFile(
  input: FileInput,
  descriptor: FileInputDescriptor,
): Buffer | undefined {
  if (descriptor.maxSize !== undefined && input.size > descriptor.maxSize) {
    throw new FileInputError(
      `File "${input.id}" is ${input.size} bytes; this argument accepts at most ${descriptor.maxSize}.`,
    );
  }

  const empty = input.size === 0;
  if (input.data === undefined) {
    if (empty) checkDigest(input, Buffer.alloc(0));
    return undefined;
  }

  if (
    input.data.length % 4 !== 0 ||
    !BASE64_PATTERN.test(input.data) ||
    // Padding may only close the string.
    /=[^=]/.test(input.data)
  ) {
    throw new FileInputError(`File "${input.id}" has data that is not base64.`);
  }
  const bytes = Buffer.from(input.data, "base64");
  if (bytes.length !== input.size) {
    throw new FileInputError(
      `File "${input.id}" declares ${input.size} bytes but its data decodes to ${bytes.length}.`,
    );
  }
  checkDigest(input, bytes);
  return empty ? undefined : bytes;
}

/** Whether a file still has to travel out of band. */
export function needsOutOfBandUpload(input: FileInput): boolean {
  return input.data === undefined && input.size > 0;
}

/**
 * Copy `args` with each listed file argument replaced.
 *
 * The arguments object is never mutated: it is also what the caller's
 * `requestState` is bound to.
 */
function replaceFileArguments(
  args: Record<string, unknown>,
  files: FileArgument[],
  replace: (file: FileArgument) => unknown,
): Record<string, unknown> {
  const copy = structuredClone(args);
  for (const file of files) {
    setAtPath(copy, file.path, replace(file));
  }
  return copy;
}

/**
 * The arguments as they may be written to logs, spans, and the tool-call
 * record: inline bytes are replaced by their size.
 */
export function redactInlineFileData(
  args: Record<string, unknown>,
  files: FileArgument[],
): Record<string, unknown> {
  if (!files.some((file) => file.input.data !== undefined)) return args;
  return replaceFileArguments(args, files, (file) =>
    file.input.data === undefined
      ? file.input
      : { ...file.input, data: `[${file.input.size} bytes omitted]` },
  );
}

export class FileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileInputError";
  }
}

// === Internal helpers ===

function walk(
  schema: unknown,
  value: unknown,
  path: FileArgumentPath,
  found: Map<string, FileArgument>,
): void {
  if (!isObject(schema) || value === undefined || value === null) return;

  const marker = schema[MCP_FILE_SCHEMA_KEYWORD];
  if (marker !== undefined && isObject(value)) {
    // The arguments object itself cannot be a file: there would be nowhere to
    // put the other arguments, and nothing to replace it with.
    if (path.length === 0) {
      throw new FileInputError(
        `The tool marks its whole input schema with ${MCP_FILE_SCHEMA_KEYWORD}, which is not supported.`,
      );
    }
    const key = JSON.stringify(path);
    if (!found.has(key)) {
      found.set(key, {
        path,
        descriptor: parseDescriptor(marker, path),
        input: parseFileInput(value, path),
      });
    }
    return;
  }

  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      for (const branch of branches) walk(branch, value, path, found);
    }
  }

  const properties = schema.properties;
  if (isObject(properties) && isObject(value)) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        walk(propertySchema, value[key], [...path, key], found);
      }
    }
  }

  const items = schema.items;
  if (Array.isArray(value) && items !== undefined) {
    value.forEach((element, index) => {
      const itemSchema = Array.isArray(items) ? items[index] : items;
      walk(itemSchema, element, [...path, index], found);
    });
  }
}

function parseDescriptor(
  marker: unknown,
  path: FileArgumentPath,
): FileInputDescriptor {
  if (!isObject(marker)) {
    throw new FileInputError(
      `The tool's ${MCP_FILE_SCHEMA_KEYWORD} at ${describePath(path)} is not an object.`,
    );
  }
  const descriptor: FileInputDescriptor = {};
  if (Array.isArray(marker.accept)) {
    descriptor.accept = marker.accept.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  if (
    typeof marker.maxSize === "number" &&
    Number.isSafeInteger(marker.maxSize) &&
    marker.maxSize >= 0
  ) {
    descriptor.maxSize = marker.maxSize;
  }
  return descriptor;
}

function parseFileInput(
  value: JsonSchemaNode,
  path: FileArgumentPath,
): FileInput {
  const where = describePath(path);
  const { id, name, mimeType, size, digest, data } = value;

  if (
    typeof id !== "string" ||
    id.length < 1 ||
    id.length > MAX_FILE_INPUT_ID_LENGTH
  ) {
    throw new FileInputError(
      `The file at ${where} needs an id of 1 to ${MAX_FILE_INPUT_ID_LENGTH} characters.`,
    );
  }
  if (typeof mimeType !== "string" || mimeType.length === 0) {
    throw new FileInputError(`File "${id}" needs a mimeType.`);
  }
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new FileInputError(
      `File "${id}" needs a size that is a non-negative integer.`,
    );
  }
  if (name !== undefined && typeof name !== "string") {
    throw new FileInputError(`File "${id}" has a name that is not a string.`);
  }
  // `data: null` is undecodable inline data, not an absent field.
  if (data !== undefined && typeof data !== "string") {
    throw new FileInputError(`File "${id}" has data that is not a string.`);
  }

  const input: FileInput = { ...value, id, mimeType, size } as FileInput;
  if (digest !== undefined) {
    if (
      !isObject(digest) ||
      digest.algorithm !== "sha-256" ||
      typeof digest.value !== "string" ||
      !BASE64URL_SHA256_PATTERN.test(digest.value)
    ) {
      throw new FileInputError(
        `File "${id}" has a digest that is not a sha-256 base64url value.`,
      );
    }
  }
  return input;
}

function checkDigest(input: FileInput, bytes: Buffer): void {
  if (!input.digest) return;
  if (sha256Base64Url(bytes) !== input.digest.value) {
    throw new FileInputError(
      `File "${input.id}" does not match its sha-256 digest.`,
    );
  }
}

function sha256Base64Url(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

function setAtPath(
  target: Record<string, unknown>,
  path: FileArgumentPath,
  value: unknown,
): void {
  let node: unknown = target;
  for (const segment of path.slice(0, -1)) {
    node = (node as Record<string | number, unknown>)[segment];
  }
  (node as Record<string | number, unknown>)[path[path.length - 1]] = value;
}

function describePath(path: FileArgumentPath): string {
  return path.length === 0 ? "the arguments root" : `"${path.join(".")}"`;
}

function isObject(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * For logs and traces written before the tool's schema is known: any object
 * shaped like a FileInput carrying inline data has the data replaced by its
 * size. Matching by shape may hide a look-alike value too, which only costs a
 * log line some detail.
 */
export function redactFileShapedData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFileShapedData);
  if (!isObject(value)) return value;
  if (
    typeof value.data === "string" &&
    typeof value.id === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.size === "number"
  ) {
    return { ...value, data: `[${value.size} bytes omitted]` };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, member]) => [
      key,
      redactFileShapedData(member),
    ]),
  );
}
