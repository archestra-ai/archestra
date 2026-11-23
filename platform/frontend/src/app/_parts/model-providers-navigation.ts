/** Model Providers' sidebar row opens the first of its two tabs the reader may see. */
export function getModelProvidersNavigationUrl(
  permissionMap: Partial<Record<string, boolean>> | null | undefined,
): "/llm/model-providers" | "/llm/models" {
  return permissionMap?.["/llm/model-providers"] === false &&
    permissionMap["/llm/models"] === true
    ? "/llm/models"
    : "/llm/model-providers";
}
