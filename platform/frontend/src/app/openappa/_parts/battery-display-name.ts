/** Preserve provider capitalization while keeping custom battery names intact. */
export function batteryDisplayName(name: string): string {
  return name === "github" ? "GitHub" : name;
}
