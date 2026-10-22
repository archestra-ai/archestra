/** Azure deployment ids remain unchanged; backing names identify the native API. */
export function getAzureModelKind(
  modelId: string,
): "text" | "image" | "audio" | "realtime" | "translation" | "embedding" {
  const name = modelId.toLowerCase();
  if (name.startsWith("text-embedding-")) return "embedding";
  if (name.startsWith("gpt-image-")) return "image";
  if (name.startsWith("gpt-realtime-translate")) return "translation";
  if (name.startsWith("gpt-realtime-") || name === "gpt-realtime")
    return "realtime";
  if (name === "gpt-audio" || name.startsWith("gpt-audio-")) return "audio";
  return "text";
}
