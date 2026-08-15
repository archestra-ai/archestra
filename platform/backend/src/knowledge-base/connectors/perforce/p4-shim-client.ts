// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import type pino from "pino";
import type { P4ShimTarget } from "@/k8s/p4-shim-runtime/manager";

/**
 * Client for the in-cluster p4 shim (`k8s/p4-shim-runtime`), used exclusively
 * by Perforce permission sync. Speaks the shim's /exec contract: allowlisted
 * `p4 -ztag -Mj` commands against the connector's Perforce server, credentials
 * per request, JSON records back.
 *
 * Admin authentication is password-based: the client logs in once per
 * instance (`p4 login -a -p` — an all-hosts ticket printed to stdout, never
 * stored server-side) and reuses the ticket for the pass. Instances are
 * per-pass, so ticket lifetime (default 12h) is never a concern.
 *
 * The admin password and minted ticket are redacted from every thrown error.
 */
export class P4ShimClient {
  private target: P4ShimTarget;
  private p4port: string;
  private username: string;
  private password: string;
  private log: pino.Logger;
  private ticket: string | null = null;

  constructor(params: {
    target: P4ShimTarget;
    /** `host:port` or `ssl:host:port` of the Perforce server. */
    p4port: string;
    /** Admin-level user (see docs: `p4 protects -a` needs super, or admin with dm.protects.allow.admin=1). */
    username: string;
    password: string;
    log: pino.Logger;
  }) {
    this.target = params.target;
    this.p4port = params.p4port;
    this.username = params.username;
    this.password = params.password;
    this.log = params.log;
  }

  /** `p4 info` with authentication — connectivity + credential probe. */
  async info(): Promise<Record<string, unknown>> {
    const result = await this.execAuthenticated("info", []);
    return result.records[0] ?? {};
  }

  /**
   * Unauthenticated `p4 info` — does this wire address speak the Perforce
   * protocol? A closed port or the wrong transport fails inside the `p4`
   * client itself (exit 1, a "Perforce client error:" block on stderr, no
   * server records), while a real p4d answers `info` at every security level
   * without a ticket. Credentials are deliberately not involved, so an
   * address that is simply wrong never reads as a credential problem.
   */
  async probe(): Promise<{ reachable: boolean; error: string | null }> {
    const result = await this.request({ command: "info", args: [] });
    if (result.exitCode === 0) return { reachable: true, error: null };
    return {
      reachable: false,
      error: this.redact(firstErrorLine(result) ?? "no error output"),
    };
  }

  /** Full protections table (`p4 protects -a`), in table order. */
  async protectsAll(): Promise<Array<Record<string, unknown>>> {
    return (await this.execAuthenticated("protects", ["-a"])).records;
  }

  /** All group names (`p4 groups`). */
  async listGroups(): Promise<string[]> {
    const result = await this.execAuthenticated("groups", []);
    return result.records
      .map((record) => String(record.group ?? ""))
      .filter(Boolean);
  }

  /** One group spec (`p4 group -o <name>`): users + subgroups. */
  async groupSpec(name: string): Promise<Record<string, unknown>> {
    const result = await this.execAuthenticated("group", ["-o", name]);
    const spec = result.records[0];
    if (!spec) {
      throw new P4ShimError(`p4 group -o ${name} returned no spec`);
    }
    return spec;
  }

  /** All users (`p4 users -a`): username, email, full name. */
  async listUsers(): Promise<Array<Record<string, unknown>>> {
    return (await this.execAuthenticated("users", ["-a"])).records;
  }

  // ===== Private methods =====

  private async execAuthenticated(
    command: string,
    args: string[],
  ): Promise<P4ShimExecResult> {
    const ticket = await this.ensureTicket();
    return this.exec({ command, args, ticket });
  }

  /**
   * Mint an all-hosts login ticket from the admin password. `p4 login -a -p`
   * prints the ticket to stdout instead of storing it; the surrounding
   * prompt/noise lines are filtered by shape.
   */
  private async ensureTicket(): Promise<string> {
    if (this.ticket) return this.ticket;
    const result = await this.exec({
      command: "login",
      args: ["-a", "-p"],
      password: this.password,
    });
    // Tagged mode wraps the ticket in a data record; plain stdout is the
    // fallback for server versions that print it bare.
    const candidates = [
      ...result.records.map((record) =>
        typeof record.data === "string" ? record.data.trim() : "",
      ),
      ...result.stdout.split("\n").map((line) => line.trim()),
    ];
    const ticket = candidates.find((line) => /^[0-9A-F]{16,}$/i.test(line));
    if (!ticket) {
      // Deliberately no output in the message: a login response is ticket
      // material even when it fails our shape check.
      const stderrLine = result.stderr
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean);
      throw new P4ShimError(
        `Perforce admin login did not return a ticket${
          stderrLine ? `: ${this.redact(stderrLine)}` : ""
        }`,
      );
    }
    this.ticket = ticket;
    return ticket;
  }

  /** {@link request} plus the usual contract that a non-zero `p4` exit is an error. */
  private async exec(params: {
    command: string;
    args: string[];
    ticket?: string;
    password?: string;
  }): Promise<P4ShimExecResult> {
    const result = await this.request(params);
    if (result.exitCode !== 0) {
      throw new P4ShimError(
        `p4 ${params.command} failed (exit ${result.exitCode}): ${this.redact(
          firstErrorLine(result) ?? "no error output",
        )}`,
      );
    }
    return result;
  }

  /**
   * One shim round trip. Transport and shim-level failures throw; a non-zero
   * `p4` exit is returned, so callers that treat failure as information (the
   * reachability probe) can inspect it.
   */
  private async request(params: {
    command: string;
    args: string[];
    ticket?: string;
    password?: string;
  }): Promise<P4ShimExecResult> {
    let response: Response;
    try {
      response = await fetch(`${this.target.baseUrl}/exec`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.target.authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          p4port: this.p4port,
          user: this.username,
          command: params.command,
          args: params.args,
          ticket: params.ticket,
          password: params.password,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new P4ShimError(
        `Could not reach the p4 shim at ${this.target.baseUrl}: ${this.redact(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new P4ShimError(
        `p4 shim request failed (${response.status}): ${this.redact(
          body.slice(0, 500),
        )}`,
      );
    }
    return (await response.json()) as P4ShimExecResult;
  }

  private redact(text: string): string {
    let redacted = text;
    for (const secret of [this.password, this.ticket]) {
      if (secret) redacted = redacted.split(secret).join("***");
    }
    return redacted;
  }
}

class P4ShimError extends Error {}

// ===== Internal helpers =====

const REQUEST_TIMEOUT_MS = 90_000;

interface P4ShimExecResult {
  exitCode: number;
  records: Array<Record<string, unknown>>;
  stdout: string;
  stderr: string;
}

function firstErrorLine(result: P4ShimExecResult): string | null {
  const fromRecords = result.records
    .map((record) =>
      typeof record.data === "string" && record.level !== undefined
        ? record.data.trim()
        : null,
    )
    .find(Boolean);
  if (fromRecords) return fromRecords;
  // A client-side failure arrives as a bare "Perforce client error:" banner
  // followed by the lines that actually say what happened, so the banner is
  // dropped and the detail kept — this is the text an operator reads when a
  // wire address is wrong.
  const detail = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "Perforce client error:")
    .slice(0, 2)
    .join(" ");
  return detail || null;
}
