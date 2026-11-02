/** Only the documented Fireworks inference origin establishes billing identity. */
export function isFireworksEndpoint(
  baseUrl: string | null | undefined,
): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "api.fireworks.ai" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      /^\/inference(?:\/v1)?\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
