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
  /**
   * Review channel for every Archestra proxy adapter: the host collects the
   * person's ruling out of band and vouches it into the runtime.
   */
  readonly reviewChannel: "host";
  /**
   * Policy declaration of whether this client can host an interactive human
   * review (native elicitation prompt or inline approval UI). This is NOT a
   * runtime gate: the `execute_remedy_plan` handler gates on the presence of
   * an elicitation channel (`context.elicitation` for chat, MRTR
   * `clientCapabilities.elicitation` for gateway clients), because that is
   * what actually carries the ruling. A client whose adapter declares
   * `supportsHitl: true` but connects without an interactive channel still
   * falls through to the upstream `NoAnswer` outcome, never a hard failure.
   */
  readonly supportsHitl: boolean;
};
