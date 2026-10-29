/** An install the backend is still deploying or discovering tools for. */
export function isInstallInProgress(
  status: string | null | undefined,
): boolean {
  return status === "pending" || status === "discovering-tools";
}
