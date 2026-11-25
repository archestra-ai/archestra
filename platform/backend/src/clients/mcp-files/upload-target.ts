/**
 * Upload targets an upstream server hands the gateway in an `upload_required`
 * result, and the checks the extension requires of any client before it sends
 * a byte to one.
 *
 * @see https://github.com/modelcontextprotocol/experimental-ext-file-uploads
 */

export const UPLOAD_REQUIRED_RESULT_TYPE = "upload_required";

export type UploadForm = {
  fields: { name: string; value: string }[];
  fileField: string;
};

export type UploadTarget = {
  fileId: string;
  url?: string;
  path?: string;
  method?: "PUT" | "POST";
  form?: UploadForm;
  headers?: Record<string, string>;
  credentials: "omit" | "include";
  expiresAt?: string;
  _meta?: Record<string, unknown>;
};

export type UploadRequiredResult = {
  resultType: typeof UPLOAD_REQUIRED_RESULT_TYPE;
  uploads: UploadTarget[];
  requestState: string;
};

export class UploadTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadTargetError";
  }
}

/** Longest target URL the gateway accepts (Claude's limit). */
const MAX_TARGET_URL_LENGTH = 8192;
const MAX_TARGET_HEADERS = 32;
const MAX_FORM_FIELDS = 32;

const TARGET_KEYS = new Set([
  "fileId",
  "url",
  "path",
  "method",
  "form",
  "headers",
  "credentials",
  "expiresAt",
  "_meta",
]);
const FORM_KEYS = new Set(["fields", "fileField"]);
const FORM_FIELD_KEYS = new Set(["name", "value"]);

/** `1*( "/" segment )`; a segment is unreserved characters, never `.` or `..`. */
const PATH_PATTERN = /^(?:\/[A-Za-z0-9\-_~.]+)+$/;
const DOT_SEGMENT_PATTERN = /\/\.{1,2}(?=\/|$)/;
/** RFC 9110 `token`. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** RFC 9110 field value: visible characters, spaces and tabs. */
const HEADER_VALUE_PATTERN = /^[\t\x20-\x7e\x80-\xff]*$/;
/** RFC 3339 date-time with a time zone. */
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/**
 * WHATWG Fetch forbidden request headers, plus the two credentials the
 * extension names. A target may not set any of them: the client owns them.
 */
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "cookie",
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-http-method",
  "x-http-method-override",
  "x-method-override",
]);
const FORBIDDEN_HEADER_PREFIXES = ["proxy-", "sec-"];

/** Headers that could reroute a request carrying a credential. */
const ROUTING_HEADERS = new Set([
  "forwarded",
  "x-original-url",
  "x-rewrite-url",
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
]);

/** Headers a multipart body defines itself. */
const FORM_FORBIDDEN_HEADERS = new Set([
  "content-type",
  "content-encoding",
  "content-range",
  "content-digest",
  "repr-digest",
]);

/**
 * Validate an upstream `upload_required` result against the files the call
 * sent without data.
 *
 * Every such file must get exactly one target and no other file may: a server
 * asking for bytes the call never offered is asking for something else.
 */
export function parseUploadRequiredResult(
  result: Record<string, unknown>,
  expectedFileIds: string[],
  options: { allowHttpLoopback: boolean },
): UploadRequiredResult {
  const { requestState, uploads } = result;
  if (typeof requestState !== "string" || requestState.length === 0) {
    throw new UploadTargetError(
      "The server asked for an upload without a requestState.",
    );
  }
  if (!Array.isArray(uploads)) {
    throw new UploadTargetError(
      "The server asked for an upload with no targets.",
    );
  }

  const expected = new Set(expectedFileIds);
  const seen = new Set<string>();
  const targets = uploads.map((raw) => {
    const target = validateUploadTarget(raw, options);
    if (!expected.has(target.fileId)) {
      throw new UploadTargetError(
        `The server asked to upload "${target.fileId}", which this call sends inline or not at all.`,
      );
    }
    if (seen.has(target.fileId)) {
      throw new UploadTargetError(
        `The server gave two targets for "${target.fileId}".`,
      );
    }
    seen.add(target.fileId);
    return target;
  });
  for (const fileId of expected) {
    if (!seen.has(fileId)) {
      throw new UploadTargetError(`The server gave no target for "${fileId}".`);
    }
  }

  return {
    resultType: UPLOAD_REQUIRED_RESULT_TYPE,
    uploads: targets,
    requestState,
  };
}

/**
 * Apply the extension's target rules. A target that breaks any of them is
 * refused outright, never repaired.
 *
 * The rule that an `include` target must be same-origin with the server needs
 * the server's address, so it lives in {@link resolveUploadTargetUrl}.
 *
 * @internal exported for tests
 */
export function validateUploadTarget(
  raw: unknown,
  options: { allowHttpLoopback: boolean },
): UploadTarget {
  if (!isObject(raw))
    throw new UploadTargetError("An upload target is not an object.");
  const target = dropNullMembers(raw);
  rejectUnknownKeys(target, TARGET_KEYS, "upload target");

  const { fileId, url, path, method, form, headers, credentials, expiresAt } =
    target;
  if (typeof fileId !== "string" || fileId.length === 0) {
    throw new UploadTargetError("An upload target has no fileId.");
  }
  const label = `The upload target for "${fileId}"`;

  if ((url === undefined) === (path === undefined)) {
    throw new UploadTargetError(
      `${label} must have exactly one of url and path.`,
    );
  }
  if (credentials !== "omit" && credentials !== "include") {
    throw new UploadTargetError(`${label} has no valid credentials mode.`);
  }
  if (method !== undefined && method !== "PUT" && method !== "POST") {
    throw new UploadTargetError(`${label} has an unsupported method.`);
  }
  if (
    expiresAt !== undefined &&
    (typeof expiresAt !== "string" ||
      !RFC3339_PATTERN.test(expiresAt) ||
      Number.isNaN(Date.parse(expiresAt)))
  ) {
    throw new UploadTargetError(`${label} has an invalid expiresAt.`);
  }
  if (target._meta !== undefined && !isObject(target._meta)) {
    throw new UploadTargetError(`${label} has a _meta that is not an object.`);
  }

  if (url !== undefined) validateTargetUrl(url, label, options);
  if (path !== undefined) {
    if (
      typeof path !== "string" ||
      !PATH_PATTERN.test(path) ||
      DOT_SEGMENT_PATTERN.test(path)
    ) {
      throw new UploadTargetError(`${label} has an invalid path.`);
    }
  }

  const validatedHeaders = validateHeaders(headers, label, {
    rerouteSensitive: path !== undefined || credentials === "include",
  });

  let validatedForm: UploadForm | undefined;
  if (form !== undefined) {
    if (method !== "POST") {
      throw new UploadTargetError(
        `${label} sends a form but its method is not POST.`,
      );
    }
    for (const name of Object.keys(validatedHeaders ?? {})) {
      if (FORM_FORBIDDEN_HEADERS.has(name.toLowerCase())) {
        throw new UploadTargetError(
          `${label} sends a form but also sets ${name}, which the form defines.`,
        );
      }
    }
    validatedForm = validateForm(form, label);
  }

  return {
    fileId,
    ...(url !== undefined && { url: url as string }),
    ...(path !== undefined && { path: path as string }),
    ...(method !== undefined && { method }),
    ...(validatedForm && { form: validatedForm }),
    ...(validatedHeaders && { headers: validatedHeaders }),
    credentials,
    ...(expiresAt !== undefined && { expiresAt: expiresAt as string }),
    ...(target._meta !== undefined && {
      _meta: target._meta as Record<string, unknown>,
    }),
  };
}

/**
 * The absolute URL a target sends to.
 *
 * A `path` is appended to the path of the server's MCP address — no doubled
 * slash, before the address's query string, which it keeps. An `include`
 * target must stay on the server's own origin: anywhere else, the credential
 * the gateway attaches would reach a party it was never issued for.
 */
export function resolveUploadTargetUrl(
  target: Pick<UploadTarget, "url" | "path" | "credentials" | "fileId">,
  mcpAddress: URL,
): URL {
  if (target.url !== undefined) {
    const url = new URL(target.url);
    if (target.credentials === "include" && url.origin !== mcpAddress.origin) {
      throw new UploadTargetError(
        `The upload target for "${target.fileId}" asks for the server's credential on another origin.`,
      );
    }
    return url;
  }
  const resolved = new URL(mcpAddress.href);
  resolved.pathname = `${mcpAddress.pathname.replace(/\/+$/, "")}${target.path}`;
  return resolved;
}

/**
 * The media type a multipart file part carries: the declared one when it is a
 * valid media type, otherwise the generic binary type.
 */
export function multipartFileContentType(mimeType: string): string {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:\s*;.*)?$/.test(
    mimeType,
  ) && HEADER_VALUE_PATTERN.test(mimeType)
    ? mimeType
    : "application/octet-stream";
}

// === Internal helpers ===

function validateTargetUrl(
  url: unknown,
  label: string,
  options: { allowHttpLoopback: boolean },
): void {
  if (typeof url !== "string" || url.length > MAX_TARGET_URL_LENGTH) {
    throw new UploadTargetError(`${label} has an invalid url.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UploadTargetError(`${label} has a url that is not absolute.`);
  }
  if (parsed.username || parsed.password) {
    throw new UploadTargetError(`${label} has a url with credentials in it.`);
  }
  if (parsed.protocol === "https:") return;
  if (
    parsed.protocol === "http:" &&
    options.allowHttpLoopback &&
    isLoopbackHostname(parsed.hostname)
  ) {
    return;
  }
  throw new UploadTargetError(`${label} has a url that is not https.`);
}

function validateHeaders(
  headers: unknown,
  label: string,
  options: { rerouteSensitive: boolean },
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  if (!isObject(headers)) {
    throw new UploadTargetError(`${label} has headers that are not an object.`);
  }
  const entries = Object.entries(headers);
  if (entries.length > MAX_TARGET_HEADERS) {
    throw new UploadTargetError(`${label} has too many headers.`);
  }
  const seen = new Set<string>();
  const validated: Record<string, string> = {};
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME_PATTERN.test(name) || typeof value !== "string") {
      throw new UploadTargetError(`${label} has an invalid header.`);
    }
    if (!HEADER_VALUE_PATTERN.test(value)) {
      throw new UploadTargetError(`${label} has an invalid value for ${name}.`);
    }
    if (seen.has(lower)) {
      throw new UploadTargetError(`${label} sets ${name} twice.`);
    }
    seen.add(lower);
    if (
      FORBIDDEN_HEADERS.has(lower) ||
      FORBIDDEN_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
    ) {
      throw new UploadTargetError(`${label} sets ${name}, which it may not.`);
    }
    if (
      options.rerouteSensitive &&
      (ROUTING_HEADERS.has(lower) || lower.startsWith("x-forwarded-"))
    ) {
      throw new UploadTargetError(`${label} sets ${name}, which it may not.`);
    }
    validated[name] = value;
  }
  return validated;
}

function validateForm(form: unknown, label: string): UploadForm {
  if (!isObject(form))
    throw new UploadTargetError(`${label} has an invalid form.`);
  rejectUnknownKeys(form, FORM_KEYS, "upload form");
  const { fields, fileField } = form;
  if (!isFormFieldName(fileField)) {
    throw new UploadTargetError(`${label} has an invalid form fileField.`);
  }
  if (!Array.isArray(fields) || fields.length > MAX_FORM_FIELDS) {
    throw new UploadTargetError(`${label} has invalid form fields.`);
  }
  const validated = fields.map((field) => {
    if (!isObject(field)) {
      throw new UploadTargetError(`${label} has an invalid form field.`);
    }
    rejectUnknownKeys(field, FORM_FIELD_KEYS, "upload form field");
    const { name, value } = field;
    if (!isFormFieldName(name) || name === fileField) {
      throw new UploadTargetError(`${label} has an invalid form field name.`);
    }
    if (typeof value !== "string" || /[\r\n\0]/.test(value)) {
      throw new UploadTargetError(`${label} has an invalid form field value.`);
    }
    return { name, value };
  });
  return { fields: validated, fileField };
}

function isFormFieldName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is refused
    !/[\x00-\x1f\x7f"\\]/.test(name)
  );
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  what: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new UploadTargetError(`An ${what} has an unknown member "${key}".`);
    }
  }
}

/** A member whose value is `null` is treated as absent. */
function dropNullMembers(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== null),
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
