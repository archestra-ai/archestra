import type { HttpHandler } from "msw";

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export type HandlerOverride = {
  method: HttpMethod;
  url: string;
  status?: number;
  body?: unknown;
  once?: boolean;
};

// Explicit switch (not `msw.http[o.method]`) so the static analyzer can see
// the method whitelist that isValidOverride enforces at runtime.
export function buildHandler(
  msw: typeof import("msw"),
  url: string,
  o: HandlerOverride,
): HttpHandler {
  const responder = () =>
    msw.HttpResponse.json(o.body ?? null, { status: o.status ?? 200 });
  const options = { once: o.once === true };
  switch (o.method) {
    case "get":
      return msw.http.get(url, responder, options);
    case "post":
      return msw.http.post(url, responder, options);
    case "put":
      return msw.http.put(url, responder, options);
    case "patch":
      return msw.http.patch(url, responder, options);
    case "delete":
      return msw.http.delete(url, responder, options);
  }
}
