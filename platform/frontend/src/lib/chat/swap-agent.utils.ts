import {
  type ArchestraToolShortName,
  extractMcpToolError,
  parseFullToolName,
  TOOL_SWAP_AGENT_SHORT_NAME,
  TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME,
} from "@shared";

export type SwapToolPart = {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

export function getSwapToolShortName(params: {
  toolName: string;
  getToolShortName?: (toolName: string) => ArchestraToolShortName | null;
}) {
  const shortName = params.getToolShortName?.(params.toolName);
  if (
    shortName === TOOL_SWAP_AGENT_SHORT_NAME ||
    shortName === TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME
  ) {
    return shortName;
  }

  const parsedToolName = parseFullToolName(params.toolName).toolName;
  if (
    parsedToolName === TOOL_SWAP_AGENT_SHORT_NAME ||
    parsedToolName === TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME
  ) {
    return parsedToolName;
  }

  if (parsedToolName.endsWith(`_${TOOL_SWAP_AGENT_SHORT_NAME}`)) {
    return TOOL_SWAP_AGENT_SHORT_NAME;
  }

  if (parsedToolName.endsWith(`_${TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME}`)) {
    return TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME;
  }

  return null;
}

export function getRenderedToolName(part: SwapToolPart): string | null {
  if (typeof part.toolName === "string") {
    return part.toolName;
  }

  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    return part.type.replace("tool-", "");
  }

  return null;
}

export function extractSwapTargetAgentName(part: SwapToolPart): string | null {
  const input =
    typeof part.input === "object" && part.input !== null
      ? (part.input as Record<string, unknown>)
      : undefined;
  if (typeof input?.agent_name === "string") {
    return input.agent_name;
  }

  const output = part.output;
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      if (typeof parsed?.agent_name === "string") {
        return parsed.agent_name;
      }
    } catch {
      return null;
    }
  }

  return null;
}

export function hasSwapToolErrorInPart(part: SwapToolPart): boolean {
  if (typeof part.errorText === "string" && part.errorText.length > 0) {
    return true;
  }

  return extractMcpToolError(part.output) !== null;
}
