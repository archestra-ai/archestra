export function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}
