import type { AppaPreparedRequest } from "@/openappa/request";
import type { AppaChatSource, OpenAppaSession } from "@/openappa/service";

export const APPA_PLUGIN_TRUSTED_CONTEXT: unique symbol = Symbol(
  "archestra.appa.trusted-context",
);

export type AppaTrustedContext = {
  /** Established by the proxy after authentication and session-root validation. */
  session: OpenAppaSession;
  profileId: string;
  canonicalizeToolName: (name: string) => string;
  /** What the proxy prepared for this request before any adapter saw it. */
  request: AppaPreparedRequest;
  /** Present only for the proxy's loopback Chat call path. */
  chatSource?: AppaChatSource;
};

export type AppaClientAdapter = {
  readonly id: string;
  /** Client signals select tool syntax, not authority; they may be spoofed. */
  matches(context: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
    requestBody: unknown;
    trustedContext?: AppaTrustedContext;
  }): boolean;
  classifyToolName(name: string): "gateway" | "local";
  normalizeLocalToolName(name: string): string;
  readonly reviewChannel: "host";
  readonly supportsHitl: boolean;
};
