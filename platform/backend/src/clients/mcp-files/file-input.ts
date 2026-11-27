import { createHash } from "node:crypto";
import { MCP_FILE_SCHEMA_KEYWORD } from "@archestra/shared";
import { isObject } from "./is-object";

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

/** What the gateway enforces of an argument's `x-mcp-file` settings. */
export type FileInputDescriptor = {
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
 * not a valid `FileInput`, or when two files share an id. A value that is not
 * an object at all is refused too, unless the marker sits in one branch of an
 * `anyOf`/`oneOf` whose other branches may describe it.
 */
export function collectFileArguments(
  schema: unknown,
  args: Record<string, unknown>,
): FileArgument[] {
  const files: FileArgument[] = [];
  for (const location of markedLocations(schema, args)) {
    if (!isObject(location.value)) {
      if (location.inAlternative) continue;
      throw new FileInputError(
        `The file argument ${describePath(location.path)} is not a file input object.`,
      );
    }
    // The arguments object itself cannot be a file: there would be nowhere to
    // put the other arguments, and nothing to replace it with.
    if (location.path.length === 0) {
      throw new FileInputError(
        `The tool marks its whole input schema with ${MCP_FILE_SCHEMA_KEYWORD}, which is not supported.`,
      );
    }
    let input: FileInput;
    try {
      input = parseFileInput(location.value, location.path);
    } catch (error) {
      // Under an alternative, an object that is no file input may well be
      // the other branch's value.
      if (error instanceof FileInputError && location.inAlternative) continue;
      throw error;
    }
    files.push({
      path: location.path,
      descriptor: parseDescriptor(location.marker, location.path),
      input,
    });
  }

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
 * The arguments as they may be written to the tool-call record: the bytes of
 * every file argument are replaced by their size, whether or not the file is
 * valid, and so is any inline data shaped like a file elsewhere.
 *
 * `args` itself is never changed: it is also what the caller's `requestState`
 * is bound to.
 */
export function redactFileArguments(
  schema: unknown,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const copy = structuredClone(args);
  for (const { value } of markedLocations(schema, copy)) {
    if (isObject(value) && value.data !== undefined) {
      value.data =
        typeof value.size === "number"
          ? `[${value.size} bytes omitted]`
          : "[omitted]";
    }
  }
  return redactFileShapedData(copy) as Record<string, unknown>;
}

/**
 * Read one file argument outside a schema walk: a built-in tool's own
 * argument, which its handler reads by name.
 */
export function readFileInput(value: unknown, name: string): FileInput {
  if (!isObject(value)) {
    throw new FileInputError(
      `The file argument "${name}" is not a file input object.`,
    );
  }
  return parseFileInput(value, [name]);
}

/**
 * The schema with every file argument removed: what a caller that cannot
 * send files is shown of a tool whose file arguments are optional. A
 * property marked as a file disappears from `properties` and `required`.
 */
export function withoutFileArguments<T>(schema: T): T {
  if (Array.isArray(schema)) {
    return schema.map((item) => withoutFileArguments(item)) as T;
  }
  if (!isObject(schema)) return schema;
  const copy: Record<string, unknown> = {};
  const dropped = new Set<string>();
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && isObject(value)) {
      const properties: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(value)) {
        if (isObject(property) && MCP_FILE_SCHEMA_KEYWORD in property) {
          dropped.add(name);
        } else {
          properties[name] = withoutFileArguments(property);
        }
      }
      copy[key] = properties;
    } else {
      copy[key] = withoutFileArguments(value);
    }
  }
  if (dropped.size > 0 && Array.isArray(copy.required)) {
    copy.required = copy.required.filter(
      (name) => typeof name !== "string" || !dropped.has(name),
    );
  }
  return copy as T;
}

export class FileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileInputError";
  }
}

// === Internal helpers ===

type MarkedLocation = {
  path: FileArgumentPath;
  marker: unknown;
  value: unknown;
  /** Under an anyOf/oneOf branch: other branches may describe the value. */
  inAlternative: boolean;
};

/**
 * Every present, non-null value in `value` that sits at an `x-mcp-file`
 * schema, once per location. Follows object `properties`, array `items`, and
 * `anyOf`/`oneOf`/`allOf` branches.
 */
function markedLocations(schema: unknown, value: unknown): MarkedLocation[] {
  const found = new Map<string, MarkedLocation>();
  const visit = (
    node: unknown,
    current: unknown,
    path: FileArgumentPath,
    inAlternative: boolean,
  ): void => {
    if (!isObject(node) || current === undefined || current === null) return;

    const marker = node[MCP_FILE_SCHEMA_KEYWORD];
    if (marker !== undefined) {
      const key = JSON.stringify(path);
      const seen = found.get(key);
      // A location any branch marks outside an alternative is a file for sure.
      if (!seen || (seen.inAlternative && !inAlternative)) {
        found.set(key, { path, marker, value: current, inAlternative });
      }
      if (isObject(current)) return;
    }

    for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
      const branches = node[keyword];
      if (Array.isArray(branches)) {
        // Every allOf branch applies to the value; an anyOf/oneOf branch is
        // only one of the shapes it may take, and so is all that lies below.
        const alternative = keyword !== "allOf" || inAlternative;
        for (const branch of branches) {
          visit(branch, current, path, alternative);
        }
      }
    }

    const properties = node.properties;
    if (isObject(properties) && isObject(current)) {
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (Object.hasOwn(current, key)) {
          visit(propertySchema, current[key], [...path, key], inAlternative);
        }
      }
    }

    const items = node.items;
    if (Array.isArray(current) && items !== undefined) {
      current.forEach((element, index) => {
        const itemSchema = Array.isArray(items) ? items[index] : items;
        visit(itemSchema, element, [...path, index], inAlternative);
      });
    }
  };
  visit(schema, value, [], false);
  return [...found.values()];
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
  // `accept` is a hint for the client choosing a file; the server behind the
  // tool is the one that holds files to it.
  const descriptor: FileInputDescriptor = {};
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

function describePath(path: FileArgumentPath): string {
  return path.length === 0 ? "the arguments root" : `"${path.join(".")}"`;
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
  if (isFileShaped(value) && typeof value.data === "string") {
    return { ...value, data: `[${value.size} bytes omitted]` };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, member]) => [
      key,
      redactFileShapedData(member),
    ]),
  );
}

/**
 * Whether any object shaped like a FileInput, anywhere in `value`, asks for an
 * out-of-band upload: a non-empty file without inline data. For decisions made
 * before the tool's schema is known; a look-alike value counts too.
 */
export function holdsFileShapedUpload(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsFileShapedUpload);
  if (!isObject(value)) return false;
  if (isFileShaped(value) && value.data === undefined && value.size > 0) {
    return true;
  }
  return Object.values(value).some(holdsFileShapedUpload);
}

function isFileShaped(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { size: number } {
  return (
    typeof value.id === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.size === "number"
  );
}
