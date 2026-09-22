/** A moving tag must be resolved again for each new workspace. */
export function usesFloatingAgentImageTag(image: string): boolean {
  return image.endsWith(":latest");
}
