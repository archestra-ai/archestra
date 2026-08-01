/**
 * Backup codes are shown exactly once, so enrollment makes the user download
 * them before continuing. The filename carries the deployment's brand and
 * host so a user enrolled in several deployments can tell the files apart.
 */
export function getBackupCodesFileName(appName: string): string {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const host =
    typeof window === "undefined" ? "" : slug(window.location.hostname);
  return `${[slug(appName), host, "2fa-backup-codes"].filter(Boolean).join("_")}.txt`;
}

export function buildBackupCodesFileContents(
  codes: string[],
  appName: string,
): string {
  const host = typeof window === "undefined" ? "" : window.location.host;
  return [
    `${appName} two-factor backup codes${host ? ` (${host})` : ""}`,
    "",
    "Each code can be used once to sign in if you lose access to your",
    "authenticator app. Keep this file somewhere safe.",
    "",
    ...codes,
    "",
  ].join("\n");
}

/**
 * Triggers a client-side download of the codes as a text file. Returns
 * whether it was actually handed to the browser — finishing enrollment is
 * gated on this, so a blocked download must not unlock the gate.
 */
export function downloadBackupCodes(codes: string[], appName: string): boolean {
  let url: string | null = null;
  try {
    const blob = new Blob([buildBackupCodesFileContents(codes, appName)], {
      type: "text/plain;charset=utf-8",
    });
    url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = getBackupCodesFileName(appName);
    document.body.appendChild(link);
    link.click();
    link.remove();
    return true;
  } catch {
    return false;
  } finally {
    if (url) {
      URL.revokeObjectURL(url);
    }
  }
}
