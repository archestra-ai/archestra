import { createClient } from "./generated/client";
import {
  getProxyV1Capabilities,
  postProxyV1Checkpoints,
  postProxyV1Events,
} from "./generated/sdk.gen";
import type {
  CheckpointRequest,
  ProxyEventEnvelope,
} from "./generated/types.gen";
import { type AppaRuntimeClientOptions, AppaRuntimeError } from "./types";

type Result = { data?: unknown; error?: unknown; response?: Response };

export class AppaRuntimeTransport {
  private readonly client;
  private readonly authorization: string;

  constructor(options: AppaRuntimeClientOptions) {
    const token = options.runtimeToken.trim();
    if (!token || /[\r\n]/.test(token)) {
      throw new AppaRuntimeError(
        "invalid-endpoint",
        "OpenAPPA proxy token is invalid",
      );
    }
    this.authorization = `Bearer ${token}`;
    this.client = createClient({
      baseUrl: trustedUrl(options.url),
      fetch: timedFetch(
        options.fetch ?? globalThis.fetch,
        options.timeoutMs ?? 10_000,
      ),
      throwOnError: false,
    });
  }

  capabilities(): Promise<unknown> {
    return this.request("capabilities", () =>
      getProxyV1Capabilities({ client: this.client, headers: this.headers() }),
    );
  }

  event(
    body: ProxyEventEnvelope,
    serializedBody: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request("event", () =>
      postProxyV1Events({
        body,
        client: this.client,
        headers: this.headers(),
        bodySerializer: () => serializedBody,
        signal,
      }),
    );
  }

  checkpoint(body: CheckpointRequest): Promise<unknown> {
    return this.request("checkpoint", () =>
      postProxyV1Checkpoints({
        body,
        client: this.client,
        headers: this.headers(),
      }),
    );
  }

  private headers(): Record<string, string> {
    return { Authorization: this.authorization };
  }

  private async request(
    name: string,
    send: () => Promise<Result>,
  ): Promise<unknown> {
    try {
      const result = await send();
      if (isAbort(result.error))
        throw new AppaRuntimeError("timeout", `OpenAPPA ${name} timed out`);
      if (result.error !== undefined || !result.response?.ok) {
        const runtimeCode = errorCode(result.error);
        throw new AppaRuntimeError(
          runtimeCode === "event_uncertain" ? "uncertain" : "refused",
          `OpenAPPA proxy refused ${name}`,
          result.response?.status,
          runtimeCode,
        );
      }
      if (result.data === undefined) {
        throw new AppaRuntimeError(
          "invalid-response",
          `OpenAPPA proxy returned no ${name} response`,
          result.response.status,
        );
      }
      return result.data;
    } catch (error) {
      if (error instanceof AppaRuntimeError) throw error;
      if (isAbort(error))
        throw new AppaRuntimeError("timeout", `OpenAPPA ${name} timed out`);
      throw new AppaRuntimeError(
        "transport",
        `OpenAPPA ${name} request failed`,
      );
    }
  }
}

function trustedUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppaRuntimeError(
      "invalid-endpoint",
      "OpenAPPA runtime URL must be absolute HTTP(S)",
    );
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new AppaRuntimeError(
      "invalid-endpoint",
      "OpenAPPA runtime URL must be a credential-free HTTP(S) origin or path prefix",
    );
  }
  return url.href.replace(/\/$/, "");
}

function timedFetch(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new AppaRuntimeError(
      "invalid-endpoint",
      "OpenAPPA timeout must be positive",
    );
  return (input, init) =>
    fetchImpl(input, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const nested = (error as Record<string, unknown>).error;
  if (typeof nested !== "object" || nested === null) return undefined;
  const code = (nested as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}
