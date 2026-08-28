import { createHash } from "node:crypto";
import type { Gemini } from "@/types";

type GeminiRequest = Gemini.Types.GenerateContentRequest;
type ResponseWithFunctionCalls = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        functionCall?: { name?: string; [key: string]: unknown };
        [key: string]: unknown;
      }>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

// =============================================================================
// PUBLIC INTERFACE
// =============================================================================

/**
 * Reversibly maps client-defined tool names onto Gemini's function-name
 * contract. Only provider-facing payloads use the encoded names; responses are
 * decoded before policy evaluation or delivery to the client.
 */
export class GeminiToolNameCodec {
  private readonly toProvider = new Map<string, string>();
  private readonly toClient = new Map<string, string>();

  constructor(request?: Partial<GeminiRequest>) {
    const names = collectDeclaredToolNames(request?.tools);

    // Reserve valid client names first so an encoded invalid name can never
    // force an already-compatible name to change based on declaration order.
    for (const name of names) {
      if (isProviderToolName(name)) {
        this.addMapping(name, name);
      }
    }
    for (const name of names) {
      if (!this.toProvider.has(name)) {
        this.addMapping(name, makeUniqueProviderToolName(name, this.toClient));
      }
    }
  }

  encodeRequest<T extends Partial<GeminiRequest>>(request: T): T {
    return {
      ...request,
      ...(request.contents
        ? { contents: this.encodeContents(request.contents) }
        : {}),
      ...(request.tools ? { tools: this.encodeTools(request.tools) } : {}),
      ...(request.toolConfig
        ? { toolConfig: this.encodeToolConfig(request.toolConfig) }
        : {}),
    } as T;
  }

  decodeResponse<T>(response: T): T {
    const shapedResponse = response as T & ResponseWithFunctionCalls;
    if (!shapedResponse.candidates) return response;

    return {
      ...shapedResponse,
      candidates: shapedResponse.candidates.map((candidate) =>
        candidate.content
          ? {
              ...candidate,
              content: {
                ...candidate.content,
                parts: candidate.content.parts?.map((part) =>
                  part.functionCall
                    ? {
                        ...part,
                        functionCall: {
                          ...part.functionCall,
                          name: this.decode(part.functionCall.name ?? ""),
                        },
                      }
                    : part,
                ),
              },
            }
          : candidate,
      ),
    } as T;
  }

  private addMapping(clientName: string, providerName: string): void {
    this.toProvider.set(clientName, providerName);
    this.toClient.set(providerName, clientName);
  }

  private encode(name: string): string {
    return this.toProvider.get(name) ?? encodeProviderToolName(name);
  }

  private decode(name: string): string {
    return this.toClient.get(name) ?? name;
  }

  private encodeContents(
    contents: GeminiRequest["contents"],
  ): GeminiRequest["contents"] {
    return contents.map((content) => ({
      ...content,
      parts: content.parts?.map((part) => {
        if ("functionCall" in part && part.functionCall) {
          return {
            ...part,
            functionCall: {
              ...part.functionCall,
              name: this.encode(part.functionCall.name ?? ""),
            },
          };
        }
        if ("functionResponse" in part && part.functionResponse) {
          return {
            ...part,
            functionResponse: {
              ...part.functionResponse,
              name: this.encode(part.functionResponse.name ?? ""),
            },
          };
        }
        return part;
      }),
    }));
  }

  private encodeTools(tools: NonNullable<GeminiRequest["tools"]>) {
    const toolArray = Array.isArray(tools) ? tools : [tools];
    const encoded = toolArray.map((tool) => ({
      ...tool,
      functionDeclarations: tool.functionDeclarations?.map((declaration) => ({
        ...declaration,
        name: this.encode(declaration.name),
      })),
    }));
    return Array.isArray(tools) ? encoded : encoded[0];
  }

  private encodeToolConfig(
    toolConfig: NonNullable<GeminiRequest["toolConfig"]>,
  ): NonNullable<GeminiRequest["toolConfig"]> {
    const functionCallingConfig = toolConfig.functionCallingConfig;
    if (!functionCallingConfig?.allowedFunctionNames) return toolConfig;

    return {
      ...toolConfig,
      functionCallingConfig: {
        ...functionCallingConfig,
        allowedFunctionNames: functionCallingConfig.allowedFunctionNames.map(
          (name) => this.encode(name),
        ),
      },
    };
  }
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

const GEMINI_MAX_TOOL_NAME_LENGTH = 128;
const TOOL_NAME_HASH_LENGTH = 8;
const GEMINI_TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const GEMINI_INVALID_TOOL_NAME_CHARS = /[^A-Za-z0-9_.:-]+/g;

function collectDeclaredToolNames(
  tools: GeminiRequest["tools"] | undefined,
): string[] {
  if (!tools) return [];
  const toolArray = Array.isArray(tools) ? tools : [tools];
  return [
    ...new Set(
      toolArray.flatMap(
        (tool) =>
          tool.functionDeclarations?.map((declaration) => declaration.name) ??
          [],
      ),
    ),
  ];
}

function isProviderToolName(name: string): boolean {
  return GEMINI_TOOL_NAME_PATTERN.test(name);
}

function makeUniqueProviderToolName(
  clientName: string,
  usedNames: Map<string, string>,
): string {
  const base = sanitizedToolNameBase(clientName);
  const hash = createHash("sha256").update(clientName).digest("hex");

  for (
    let hashLength = TOOL_NAME_HASH_LENGTH;
    hashLength <= hash.length;
    hashLength += 4
  ) {
    const suffix = `_${hash.slice(0, hashLength)}`;
    const candidate = `${base.slice(
      0,
      GEMINI_MAX_TOOL_NAME_LENGTH - suffix.length,
    )}${suffix}`;
    const existing = usedNames.get(candidate);
    if (existing === undefined || existing === clientName) return candidate;
  }

  // A full SHA-256 collision is not practically reachable, but keep the map
  // total even if one is forced in a test or by a future hash substitution.
  let discriminator = 2;
  while (true) {
    const suffix = `_${hash}_${discriminator}`;
    const candidate = `${base.slice(
      0,
      GEMINI_MAX_TOOL_NAME_LENGTH - suffix.length,
    )}${suffix}`;
    if (!usedNames.has(candidate)) return candidate;
    discriminator++;
  }
}

function encodeProviderToolName(name: string): string {
  if (isProviderToolName(name)) return name;
  return makeUniqueProviderToolName(name, new Map());
}

function sanitizedToolNameBase(name: string): string {
  let sanitized = name.replace(GEMINI_INVALID_TOOL_NAME_CHARS, "_");
  if (sanitized.length === 0) sanitized = "_";
  if (!/^[A-Za-z_]/.test(sanitized)) sanitized = `_${sanitized}`;
  return sanitized;
}
