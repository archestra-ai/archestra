export const ARCHESTRA_TOOL_NAME_TAG = "archestra-tool-name";
export const ARCHESTRA_TOOL_ARGUMENTS_TAG = "archestra-tool-arguments";
export const ARCHESTRA_TOOL_REASON_TAG = "archestra-tool-reason";

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
  const match = input.match(
    new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`),
  );
  return match?.[1];
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
