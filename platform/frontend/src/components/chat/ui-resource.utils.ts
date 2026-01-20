export type UIResource = {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
};

const UI_MIME_TYPES = [
  "text/html",
  "text/uri-list",
  "application/vnd.mcp-ui.remote-dom",
];

export function isUIResource(output: unknown): output is UIResource {
  if (!output || typeof output !== "object") return false;

  const resource = output as Record<string, unknown>;
  if (typeof resource.uri !== "string") return false;
  if (!resource.uri.startsWith("ui://")) return false;

  const hasContent =
    typeof resource.text === "string" || typeof resource.blob === "string";
  if (!hasContent) return false;

  if (resource.mimeType && typeof resource.mimeType === "string") {
    return UI_MIME_TYPES.includes(resource.mimeType);
  }

  return true;
}

export function extractUIResource(output: unknown): UIResource | null {
  if (isUIResource(output)) return output;

  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      if (isUIResource(parsed)) return parsed;
      if (parsed?.resource && isUIResource(parsed.resource)) {
        return parsed.resource;
      }
    } catch {
      return null;
    }
  }

  if (output && typeof output === "object") {
    const obj = output as Record<string, unknown>;
    if (obj.resource && isUIResource(obj.resource)) {
      return obj.resource as UIResource;
    }
    if (Array.isArray(obj.content)) {
      for (const item of obj.content) {
        if (item?.type === "resource" && isUIResource(item.resource)) {
          return item.resource;
        }
      }
    }
  }

  return null;
}
