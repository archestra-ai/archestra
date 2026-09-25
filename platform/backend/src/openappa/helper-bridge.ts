import { timingSafeEqual } from "node:crypto";
import type { EnvironmentTarget } from "@archestra/sandbox-rs";
import config from "@/config";
import { daggerEnvironmentRuntimeManager } from "@/k8s/dagger-environment-runtime/manager";
import { withDeadline } from "@/k8s/mcp-server-runtime";
import logger from "@/logging";
import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import OrganizationModel from "@/models/organization";
import { sandboxRuntimeService } from "@/sandbox-runtime/sandbox-runtime-service";
import { resolveCredentialValue } from "@/services/credentials";
import { skillRootPath } from "@/skills-sandbox/runtime-image";
import { shellQuote } from "@/utils/shell-quote";
import { archestraAudience } from "./archestra-audience";
import { openappaDeclarations } from "./declarations";

/**
 * The last line a helper wrote to stderr, safe as a header value. Untrusted:
 * passed through to the runtime's consult record, never parsed or acted on.
 */
export type HelperDiagnostics = string & {
  readonly __brand: "HelperDiagnostics";
};

export type HelperConsultOutcome =
  | {
      kind: "answered";
      answer: Record<string, unknown>;
      diagnostics?: HelperDiagnostics;
    }
  | { kind: "not_found" }
  | { kind: "failed"; reason: string; diagnostics?: HelperDiagnostics }
  | { kind: "timed_out"; diagnostics?: HelperDiagnostics }
  | { kind: "busy" };

/**
 * Runs a battery's helper script for one consult: the install named in the
 * URL supplies the organization, the credential bindings and the battery whose
 * files are mounted read-only into a fresh sandbox. The consult envelope goes in
 * on stdin, the credential as a Dagger secret, and the helper's stdout comes
 * back as the answer, with the last line of its stderr as diagnostics. Nothing
 * about the run is persisted here.
 */
class OpenAppaHelperBridge {
  /** Consults in flight, a raced-out run included until it settles. */
  private inFlight = 0;

  presentsBridgeToken(authorization: string | undefined): boolean {
    const expected = Buffer.from(`Bearer ${openappaDeclarations.bridgeToken}`);
    const presented = Buffer.from(authorization ?? "");
    return (
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    );
  }

  async consult(params: {
    installId: string;
    externalName: string;
    request: string;
  }): Promise<HelperConsultOutcome> {
    const startedAt = Date.now();
    const context = {
      installId: params.installId,
      externalName: params.externalName,
    };
    let outcome: HelperConsultOutcome;
    // Helpers share the sandbox pool with every other consumer; they may take
    // at most half of it, and a raced-out run holds its share until it settles.
    if (this.inFlight >= helperConsultCap()) outcome = { kind: "busy" };
    else {
      this.inFlight++;
      const work = this.run(params);
      const release = () => {
        this.inFlight--;
      };
      work.then(release, release);
      try {
        outcome = await withDeadline(
          work,
          HELPER_DEADLINE_MS,
          () => new HelperDeadlineError(),
        );
      } catch (error) {
        if (!(error instanceof HelperDeadlineError)) throw error;
        work.then(
          (late) =>
            logger.info(
              { ...context, outcome: late.kind },
              "OpenAPPA battery helper settled after its deadline",
            ),
          (late) =>
            logger.warn(
              { ...context, error: late },
              "OpenAPPA battery helper failed after its deadline",
            ),
        );
        outcome = { kind: "timed_out" };
      }
    }
    logger.info(
      { ...context, outcome: outcome.kind, durationMs: Date.now() - startedAt },
      "OpenAPPA battery helper consulted",
    );
    return outcome;
  }

  private async run(params: {
    installId: string;
    externalName: string;
    request: string;
  }): Promise<HelperConsultOutcome> {
    const install = await OpenAppaBatteryInstallModel.findById(
      params.installId,
    );
    // A row the recompose deleted takes its helper endpoint with it.
    if (!install) return { kind: "not_found" };
    const battery = await openappaDeclarations.resolveInstalled({
      organizationId: install.organizationId,
      name: install.batteryName,
      packageHash: install.packageHash,
    });
    const external = battery?.externals.find(
      (candidate) => candidate.name === params.externalName,
    );
    if (!battery || !external) return { kind: "not_found" };
    if (
      archestraAudience.serves({
        batteryName: install.batteryName,
        packageHash: install.packageHash,
        externalName: external.name,
      })
    )
      return archestraAudience.consult({
        organizationId: install.organizationId,
        request: params.request,
      });

    const resolved = await Promise.all(
      battery.credentials.map((credential) =>
        this.resolveCredential({ install, credential }),
      ),
    );
    const secretEnv: Array<{ name: string; value: string }> = [];
    for (const entry of resolved) {
      if ("failure" in entry)
        return {
          kind: "failed",
          reason: `credential ${entry.credential} ${CREDENTIAL_FAILURES[entry.failure]}`,
        };
      secretEnv.push({ name: entry.credential, value: entry.value });
    }

    const environment = await this.organizationEngine(install.organizationId);
    const cwd = skillRootPath(battery.name);
    let executed: Awaited<ReturnType<typeof sandboxRuntimeService.runCommand>>;
    try {
      await sandboxRuntimeService.attach(CONSUMER_ID);
      executed = await sandboxRuntimeService.runCommand({
        command: external.command.map(shellQuote).join(" "),
        cwd,
        timeoutSeconds: HELPER_EXEC_TIMEOUT_SECONDS,
        replayEntries: [
          {
            kind: "skill_mount",
            skillMount: {
              skillName: battery.name,
              files: battery.files.map((file) => ({
                skillName: battery.name,
                path: file.path,
                encoding: "utf8",
                content: file.text,
              })),
            },
          },
        ],
        secretEnv,
        environment,
        stdin: params.request,
        outputBytesLimit: config.skillsSandbox.outputBytesLimit,
        fileSizeLimitBytes: config.skillsSandbox.artifactBytesLimit,
        cpuSeconds: config.skillsSandbox.cpuLimit,
        memoryBytes: config.skillsSandbox.memoryLimit,
      });
    } catch (error) {
      logger.warn(
        { installId: install.id, externalName: external.name, error },
        "OpenAPPA battery helper could not run",
      );
      return { kind: "failed", reason: "the helper sandbox is unavailable" };
    }
    const diagnostics = helperDiagnostics(executed.stderr);
    if (executed.timedOut) return { kind: "timed_out", diagnostics };
    if (executed.exitCode !== 0)
      return {
        kind: "failed",
        reason: `the helper exited with status ${executed.exitCode}`,
        diagnostics,
      };
    const answer = parseJsonObject(executed.stdout);
    return answer
      ? { kind: "answered", answer, diagnostics }
      : {
          kind: "failed",
          reason: "the helper did not print a JSON object",
          diagnostics,
        };
  }

  private async resolveCredential(params: {
    install: {
      id: string;
      organizationId: string;
      credentialBindings: Record<string, string>;
    };
    credential: string;
  }): Promise<ResolvedCredential> {
    const { install, credential } = params;
    const key = install.credentialBindings[credential];
    if (!key) return { credential, failure: "unbound" };
    let value: string | null;
    try {
      value = await resolveCredentialValue({
        organizationId: install.organizationId,
        credentialId: key,
        scope: "organization",
      });
    } catch (error) {
      logger.warn(
        { installId: install.id, credential, error },
        "OpenAPPA battery credential could not be resolved",
      );
      value = null;
    }
    return value === null
      ? { credential, failure: "no_organization_value" }
      : { credential, value };
  }

  /**
   * The engine the organization's own sandbox runs use, carrying its egress
   * policy. An operator-supplied runner host serves every run from the
   * process default instead, as it does for unbound agents.
   */
  private async organizationEngine(
    organizationId: string,
  ): Promise<EnvironmentTarget | undefined> {
    if (config.daggerRuntime.runnerHost) return undefined;
    const organization =
      await OrganizationModel.getDefaultEngineTarget(organizationId);
    if (!organization) return undefined;
    return daggerEnvironmentRuntimeManager.organizationDefaultTarget(
      organization,
    );
  }
}

export const openappaHelperBridge = new OpenAppaHelperBridge();

type ResolvedCredential =
  | { credential: string; value: string }
  | { credential: string; failure: CredentialFailure };

type CredentialFailure = "unbound" | "no_organization_value";

const CREDENTIAL_FAILURES: Record<CredentialFailure, string> = {
  unbound: "is unbound",
  no_organization_value: "has no organization value",
};

const CONSUMER_ID = "openappa-helper-bridge";
/** The helper's own execution budget inside the container. */
const HELPER_EXEC_TIMEOUT_SECONDS = 4;
/**
 * Wall-clock budget for one helper consult, container materialization
 * included: the execution budget plus a margin, kept under the runtime's own
 * consult timeout so a slow helper surfaces here as a timeout instead of as a
 * silent NoAnswer upstream.
 */
const HELPER_DEADLINE_MS = HELPER_EXEC_TIMEOUT_SECONDS * 1000 + 500;

function helperConsultCap(): number {
  return Math.max(1, Math.floor(config.daggerRuntime.maxConcurrent / 2));
}

class HelperDeadlineError extends Error {}

/** The runtime keeps at most 8 KiB of diagnostics. */
const DIAGNOSTICS_LIMIT = 8 * 1024;
/** What Node accepts in a header value: tab, printable ASCII, latin1. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]+$/;

/**
 * The last non-empty line of the helper's stderr tail, or none when that line
 * is not a valid header value or does not fit whole in the tail.
 */
function helperDiagnostics(stderr: string): HelperDiagnostics | undefined {
  const cut = stderr.length > DIAGNOSTICS_LIMIT;
  const lines = stderr.slice(-DIAGNOSTICS_LIMIT).split("\n");
  // A cut tail begins mid-line: its first line may be the end of a longer one.
  const whole = cut ? lines.slice(1) : lines;
  const last = whole
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  return last !== undefined && HEADER_VALUE.test(last)
    ? (last as HelperDiagnostics)
    : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
