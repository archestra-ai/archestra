import { createHash } from "node:crypto";

/**
 * The policy's view of a tool result's content: the same structure, with the
 * payload of each binary part (an image, a document, audio, video) replaced by
 * a short marker that states its media type, its decoded size and the SHA-256
 * of its decoded bytes. Text stays in full.
 *
 * OpenAPPA records the body it is handed, so binary payloads must not be in it:
 * megabytes of base64 would be stored in every event, and nothing in a policy
 * can read them. The marker is also what the model reads if the runtime
 * rewrites the result, and the hash lets a later request be told apart from
 * this one when the same tool call id comes back with different bytes.
 *
 * Only the shapes below are recognised. A payload that does not decode as
 * base64, a remote URL, and every other shape are left as they are.
 */
export function policyView(content: unknown): unknown {
  // The runtime body and the write-back both need the view of one request's
  // content, and clients resend every earlier result on every request. An
  // adapter hands both the same object, so the second call shares the pass.
  if (typeof content !== "object" || content === null) return content;
  if (VIEWS.has(content)) return VIEWS.get(content);
  const view = viewOf(content);
  VIEWS.set(content, view);
  return view;
}

// === Internal helpers ===

const VIEWS = new WeakMap<object, unknown>();

function viewOf(content: unknown): unknown {
  if (Array.isArray(content)) {
    let changed = false;
    const items = content.map((item) => {
      const view = policyView(item);
      if (view !== item) changed = true;
      return view;
    });
    return changed ? items : content;
  }
  if (typeof content !== "object" || content === null) return content;

  const node = content as Record<string, unknown>;
  const replaced = binaryPartView(node);
  if (replaced) return replaced;

  let copy: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(node)) {
    const view = policyView(value);
    if (view === value) continue;
    copy ??= { ...node };
    copy[key] = view;
  }
  return copy ?? content;
}

/** The part with its payload swapped for a marker, when it is a binary part. */
function binaryPartView(
  node: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const type = node.type;

  // Anthropic `image` and `document` blocks with an inline base64 source.
  if ((type === "image" || type === "document") && isRecord(node.source)) {
    const source = node.source;
    if (source.type !== "base64") return undefined;
    const data = markerFor(source.data, stringOf(source.media_type));
    return data === undefined
      ? undefined
      : { ...node, source: { ...source, data } };
  }

  // MCP `image` and `audio` content.
  if ((type === "image" || type === "audio") && "data" in node) {
    const data = markerFor(node.data, stringOf(node.mimeType));
    return data === undefined ? undefined : { ...node, data };
  }

  // MCP embedded `resource` with a `blob`.
  if (type === "resource" && isRecord(node.resource)) {
    const resource = node.resource;
    const blob = markerFor(resource.blob, stringOf(resource.mimeType));
    return blob === undefined
      ? undefined
      : { ...node, resource: { ...resource, blob } };
  }

  // OpenAI Responses `input_image` (a data URL) and `input_file`.
  if (type === "input_image") {
    const image_url = markerFor(node.image_url);
    return image_url === undefined ? undefined : { ...node, image_url };
  }
  if (type === "input_file") {
    const file_data = markerFor(node.file_data);
    return file_data === undefined ? undefined : { ...node, file_data };
  }

  // Chat completions `image_url`, `input_audio` and `file` parts.
  if (type === "image_url" && isRecord(node.image_url)) {
    const url = markerFor(node.image_url.url);
    return url === undefined
      ? undefined
      : { ...node, image_url: { ...node.image_url, url } };
  }
  if (type === "input_audio" && isRecord(node.input_audio)) {
    const audio = node.input_audio;
    const format = stringOf(audio.format);
    const data = markerFor(audio.data, format ? `audio/${format}` : undefined);
    return data === undefined
      ? undefined
      : { ...node, input_audio: { ...audio, data } };
  }
  if (type === "file" && isRecord(node.file)) {
    const file_data = markerFor(node.file.file_data);
    return file_data === undefined
      ? undefined
      : { ...node, file: { ...node.file, file_data } };
  }

  // Bedrock `image`, `document` and `video` blocks: `source.bytes`.
  for (const kind of ["image", "document", "video"] as const) {
    const block = node[kind];
    if (!isRecord(block) || !isRecord(block.source)) continue;
    const bytes = markerFor(
      block.source.bytes,
      stringOf(block.format) ? `${kind}/${block.format}` : kind,
    );
    return bytes === undefined
      ? undefined
      : {
          ...node,
          [kind]: { ...block, source: { ...block.source, bytes } },
        };
  }

  // Gemini `inlineData`.
  if (isRecord(node.inlineData)) {
    const inline = node.inlineData;
    const data = markerFor(inline.data, stringOf(inline.mimeType));
    return data === undefined
      ? undefined
      : { ...node, inlineData: { ...inline, data } };
  }

  return undefined;
}

const DATA_URL = /^data:([^;,]*)(?:;[^;,]*)*;base64,([\s\S]*)$/;
// Standard or URL-safe alphabet, padded or not: Gemini's JSON bytes accept all four.
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

/** The marker for a base64 payload or base64 data URL, or undefined if it is neither. */
function markerFor(payload: unknown, mediaType?: string): string | undefined {
  if (typeof payload !== "string" || payload.length === 0) return undefined;
  let encoded = payload;
  let type = mediaType;
  const url = DATA_URL.exec(payload);
  if (url) {
    encoded = url[2];
    type = url[1] || type;
  } else if (payload.startsWith("data:")) {
    return undefined;
  }
  encoded = encoded.replace(/\s+/g, "");
  if (!BASE64.test(encoded)) return undefined;
  // A single leftover character cannot encode a byte.
  if (encoded.replace(/=+$/, "").length % 4 === 1) return undefined;
  if (encoded.length === 0) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `[binary ${type || "data"}, ${bytes.length} bytes, sha256 ${digest}]`;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
