import { UIResourceSchema } from "./schemas";
export type UIResourceMimeType =
  | "text/html"
  | "text/uri-list"
  | "application/vnd.mcp-ui.remote-dom"
  | `application/vnd.mcp-ui.remote-dom+javascript; framework=${"react" | "webcomponents"}`;

export interface UIResourceContent {
  uri: string;
  mimeType: UIResourceMimeType;
  text?: string;
  blob?: string;
}

export interface UIResource {
  type: "resource";
  resource: UIResourceContent;
}

export type UIActionType = "tool" | "intent" | "prompt" | "notify" | "link";

export interface UIActionTool {
  type: "tool";
  payload: { toolName: string; params: Record<string, unknown> };
  messageId?: string;
}

export interface UIActionIntent {
  type: "intent";
  payload: { intent: string; params: Record<string, unknown> };
  messageId?: string;
}

export interface UIActionPrompt {
  type: "prompt";
  payload: { prompt: string };
  messageId?: string;
}

export interface UIActionNotify {
  type: "notify";
  payload: { message: string };
  messageId?: string;
}

export interface UIActionLink {
  type: "link";
  payload: { url: string };
  messageId?: string;
}

export type UIActionResult =
  | UIActionTool
  | UIActionIntent
  | UIActionPrompt
  | UIActionNotify
  | UIActionLink;

export function isUIResource(content: unknown): content is UIResource {
  return UIResourceSchema.safeParse(content).success;
}

const extractionCache = new WeakMap<object, UIResource | null>();

export function extractUIResourceFromOutput(
  output: unknown,
): UIResource | null {
  if (!output) return null;

  // 1. Direct check if the output is already a UIResource
  if (isUIResource(output)) return output;

  // 2. Handle stringified JSON
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      return extractUIResourceFromOutput(parsed);
    } catch {
      if (output.trim().length > 0) {
        return {
          type: "resource",
          resource: {
            uri: `ui://text-content/${Date.now()}`,
            mimeType: "text/html",
            text: output,
          },
        };
      }
      return null;
    }
  }

  // 3. Handle arrays by searching for a UI resource within them
  if (Array.isArray(output)) {
    if (extractionCache.has(output)) {
      return extractionCache.get(output)!;
    }

    for (const item of output) {
      const result = extractUIResourceFromOutput(item);
      if (result) {
        extractionCache.set(output, result);
        return result;
      }
    }
    
    extractionCache.set(output, null);
    return null;
  }

  // 4. Handle objects
  if (typeof output === "object" && output !== null) {
    if (extractionCache.has(output)) {
      return extractionCache.get(output)!;
    }

    const obj = output as Record<string, unknown>;

    // Check for nested UI resources in object properties, like `content`
    if (Array.isArray(obj.content)) {
      for (const item of obj.content) {
        const result = extractUIResourceFromOutput(item);
        if (result) {
          extractionCache.set(output, result);
          return result;
        }
      }
    }

    // Check if the object contains a `resource` property that's a valid UI resource content
    if (obj.resource && typeof obj.resource === "object") {
      const resource = obj.resource as Record<string, unknown>;
      if (
        typeof resource.uri === "string" &&
        resource.uri.startsWith("ui://") &&
        typeof resource.mimeType === "string"
      ) {
        const result = {
          type: "resource",
          resource: {
            uri: resource.uri,
            mimeType: resource.mimeType as UIResourceMimeType,
            text: typeof resource.text === "string" ? resource.text : undefined,
            blob: typeof resource.blob === "string" ? resource.blob : undefined,
          },
        };
        extractionCache.set(output, result);
        return result;
      }
    }

    for (const value of Object.values(obj)) {
      if (isUIResource(value)) {
        extractionCache.set(output, value);
        return value;
      }
    }

    if (Object.keys(obj).length > 0) {
      try {
        const htmlContent = convertObjectToHtml(obj);
        if (htmlContent) {
          const result = {
            type: "resource",
            resource: {
              uri: `ui://auto-generated/${Date.now()}`,
              mimeType: "text/html",
              text: htmlContent,
            },
          };
          extractionCache.set(output, result);
          return result;
        }
      } catch {
        extractionCache.set(output, null);
        return null;
      }
    }
    
    extractionCache.set(output, null);
  }

  return null;
}

function convertObjectToHtml(obj: Record<string, unknown>): string | null {
  if (Object.keys(obj).length === 0) return null;

  let html = '<div class="p-4 font-sans">';

  if (obj.title || obj.name) {
    html += `<h2 class="text-foreground mb-4">${obj.title || obj.name}</h2>`;
  }

  html +=
    '<table class="w-full border-collapse mt-2">';
  html += '<thead><tr class="bg-card">';
  html +=
    '<th class="text-left p-2 border border-border">Property</th>';
  html +=
    '<th class="text-left p-2 border border-border">Value</th>';
  html += "</tr></thead><tbody>";

  for (const [key, value] of Object.entries(obj)) {
    if (key === "title" || key === "name") continue;

    let displayValue = "";
    if (value === null || value === undefined) {
      displayValue = '<span class="text-muted-foreground">null</span>';
    } else if (typeof value === "object") {
      displayValue = `<pre class="m-0 whitespace-pre-wrap text-xs">${JSON.stringify(value, null, 2)}</pre>`;
    } else {
      displayValue = String(value);
    }

    html += `<tr class="border-b border-border">`;
    html += `<td class="p-2 border border-border font-bold">${key}</td>`;
    html += `<td class="p-2 border border-border">${displayValue}</td>`;
    html += `</tr>`;
  }

  html += "</tbody></table></div>";

  return html;
}
