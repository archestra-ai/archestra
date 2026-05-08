import type { IncomingHttpHeaders } from "node:http";

export function getPublicRequestOrigin(params: {
  protocol: string;
  headers: IncomingHttpHeaders;
}): string {
  const host =
    getFirstHeaderValue(params.headers["x-forwarded-host"]) ??
    getFirstHeaderValue(params.headers.host) ??
    "localhost";
  const protocol = (
    getFirstHeaderValue(params.headers["x-forwarded-proto"]) ??
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
