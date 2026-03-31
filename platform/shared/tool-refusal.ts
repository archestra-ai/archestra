export const ARCHESTRA_TOOL_NAME_TAG = "archestra-tool-name";
export const ARCHESTRA_TOOL_ARGUMENTS_TAG = "archestra-tool-arguments";
export const ARCHESTRA_TOOL_REASON_TAG = "archestra-tool-reason";
const MAX_REFUSAL_METADATA_LENGTH = 50_000;

export type ArchestraToolRefusalInfo = {
  toolName?: string;
  toolArguments?: string;
  reason?: string;
};

export function extractTaggedValue(params: {
  input: string;
  tagName: string;
}): string | undefined {
  const { input, tagName } = params;
  if (input.length > MAX_REFUSAL_METADATA_LENGTH) {
    return undefined;
  }

  const openTag = `<${tagName}>`;
  const closeTag = `</${tagName}>`;
  const startIndex = input.indexOf(openTag);
  if (startIndex === -1) {
    return undefined;
  }

  const valueStartIndex = startIndex + openTag.length;
  const endIndex = input.indexOf(closeTag, valueStartIndex);
  if (endIndex === -1) {
    return undefined;
  }

  return input.slice(valueStartIndex, endIndex);
}

export function parseArchestraToolRefusal(
  input: string,
): ArchestraToolRefusalInfo {
  return {
    toolName: extractTaggedValue({
      input,
      tagName: ARCHESTRA_TOOL_NAME_TAG,
    }),
    toolArguments: extractTaggedValue({
      input,
      tagName: ARCHESTRA_TOOL_ARGUMENTS_TAG,
    }),
    reason: extractTaggedValue({
      input,
      tagName: ARCHESTRA_TOOL_REASON_TAG,
    }),
  };
}

export function buildArchestraToolRefusalMetadata(params: {
  toolName: string;
  toolArguments: string;
  reason: string;
}): string {
  const { toolName, toolArguments, reason } = params;
  return [
    `<${ARCHESTRA_TOOL_NAME_TAG}>${toolName}</${ARCHESTRA_TOOL_NAME_TAG}>`,
    `<${ARCHESTRA_TOOL_ARGUMENTS_TAG}>${toolArguments}</${ARCHESTRA_TOOL_ARGUMENTS_TAG}>`,
    `<${ARCHESTRA_TOOL_REASON_TAG}>${reason}</${ARCHESTRA_TOOL_REASON_TAG}>`,
  ].join("\n");
}
