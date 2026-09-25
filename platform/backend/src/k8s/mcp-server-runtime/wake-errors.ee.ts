// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

/** A wake did not reach ready within the request budget; the call may retry. */
export class McpServerWakeError extends Error {
  /** The wake reached a verdict rather than losing a retryable race. */
  readonly concluded: boolean;
  /** Reason without the original install's server name baked in. */
  readonly detail?: string;
  /** Extra sentence appended after the ordinary message. */
  readonly suffix?: string;

  constructor(
    serverName: string,
    options?: ErrorOptions & {
      detail?: string;
      concluded?: boolean;
      suffix?: string;
    },
  ) {
    super(
      `MCP server ${serverName} is waking from idle hibernation but ${
        options?.detail ?? "did not become ready in time"
      }; retry shortly.${options?.suffix ? ` ${options.suffix}` : ""}`,
      options,
    );
    this.name = "McpServerWakeError";
    this.concluded = options?.concluded ?? false;
    this.detail = options?.detail;
    this.suffix = options?.suffix;
  }
}

/** A wake is still in progress when this caller's response budget ends. */
export class McpServerWakePendingError extends McpServerWakeError {
  constructor(serverName: string, waitedMs: number) {
    super(serverName, {
      detail:
        `it is still starting up and did not become ready within ${Math.round(waitedMs / 1000)}s. ` +
        "It is still starting in the background: retry this same tool call with the same arguments " +
        "in about 30 seconds and it should run normally. Nothing needs to be fixed or changed",
    });
    this.name = "McpServerWakePendingError";
  }
}
