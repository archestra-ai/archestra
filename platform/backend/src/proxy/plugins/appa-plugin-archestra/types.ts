import type { AppaPreparedRequest } from "@/openappa/request";
import type { AppaChatSource, OpenAppaSession } from "@/openappa/service";
import type { AppaSessionIdentity } from "@/openappa/wire";

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
  /**
   * Reads the trajectory identity the client itself puts on the wire: the id
   * it keeps stable across a resumed or compacted conversation and replaces
   * on a fork, so a resume reopens the same OpenAPPA root and a fork opens a
   * fresh one. Runs before the generic wire-family fallbacks; returning
   * `undefined` defers to them. A request whose native signals contradict
   * each other is refused rather than bound to a trajectory chosen by
   * precedence.
   */
  extractSessionIdentity?(context: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
    requestBody: unknown;
  }): AppaSessionIdentity | undefined;
};
