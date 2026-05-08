import type { IncomingHttpHeaders } from "node:http";

export function getPublicRequestOrigin(params: {
  protocol: string;
  headers: IncomingHttpHeaders;
  trustProxy: unknown;
}): string {
  const trustForwardedHeaders = Boolean(params.trustProxy);
  const host =
    (trustForwardedHeaders
      ? getFirstHeaderValue(params.headers["x-forwarded-host"])
      : undefined) ??
    getFirstHeaderValue(params.headers.host) ??
    "localhost";
  const protocol = (
    (trustForwardedHeaders
      ? getFirstHeaderValue(params.headers["x-forwarded-proto"])
      : undefined) ??
    params.protocol ??
    "http"
  ).replace(/:$/, "");

  return `${protocol}://${host}`;
}

function getFirstHeaderValue(
  header: string | string[] | undefined,
): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(",")[0]?.trim() || undefined;
}
