import { timingSafeEqual } from "node:crypto";
import config from "@/config";
import logger from "@/logging";
import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import { sandboxRuntimeService } from "@/sandbox-runtime/sandbox-runtime-service";
import { resolveCredentialValue } from "@/services/credentials";
import { skillRootPath } from "@/skills-sandbox/runtime-image";
import { shellQuote } from "@/utils/shell-quote";
import { openappaBatteriesService } from "./batteries";

/**
 * Wall-clock budget for one helper consult, container materialization
 * included. It sits under the runtime's own consult timeout so a slow helper
 * surfaces here as a timeout instead of as a silent NoAnswer upstream.
 */
const HELPER_DEADLINE_MS = 4_500;

type HelperConsultOutcome =
  | { kind: "answered"; answer: Record<string, unknown> }
  | { kind: "not_found" }
  | { kind: "failed"; reason: string }
  | { kind: "timed_out" };

/**
 * Runs a battery's helper script for one consult: the install named in the
 * URL supplies the organization, the credential bindings and the battery whose
 * files are mounted read-only into a fresh sandbox. The consult envelope goes in
 * on stdin, the credential as a Dagger secret, and the helper's stdout comes
 * back as the answer. Nothing about the run is persisted.
 */
class OpenAppaHelperBridge {
  presentsBridgeToken(authorization: string | undefined): boolean {
    const expected = Buffer.from(
      `Bearer ${openappaBatteriesService.bridgeToken}`,
    );
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
    const outcome = await this.run(params);
    logger.info(
      {
        installId: params.installId,
        externalName: params.externalName,
        outcome: outcome.kind,
        durationMs: Date.now() - startedAt,
      },
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
    if (!install?.enabled) return { kind: "not_found" };
    const battery = await openappaBatteriesService.resolveBattery(
      install.organizationId,
      install.batteryName,
    );
    const external = battery?.externals.find(
      (candidate) => candidate.name === params.externalName,
    );
    if (!battery || !external) return { kind: "not_found" };

    const secretEnv: Array<{ name: string; value: string }> = [];
    for (const credential of battery.credentials) {
      const key = install.credentialBindings[credential];
      if (!key)
        return {
          kind: "failed",
          reason: `credential ${credential} is unbound`,
        };
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
      if (value === null)
        return {
          kind: "failed",
          reason: `credential ${credential} has no organization value`,
        };
      secretEnv.push({ name: credential, value });
    }

    const cwd = skillRootPath(battery.name);
    let executed: Awaited<ReturnType<typeof sandboxRuntimeService.runCommand>>;
    try {
      // A cold engine session counts against the consult budget too.
      const run = sandboxRuntimeService.attach(CONSUMER_ID).then(() =>
        sandboxRuntimeService.runCommand({
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
          stdin: params.request,
          outputBytesLimit: config.skillsSandbox.outputBytesLimit,
          fileSizeLimitBytes: config.skillsSandbox.artifactBytesLimit,
          cpuSeconds: config.skillsSandbox.cpuLimit,
          memoryBytes: config.skillsSandbox.memoryLimit,
        }),
      );
      const raced = await withDeadline(run, HELPER_DEADLINE_MS);
      if (raced === DEADLINE) return { kind: "timed_out" };
      executed = raced;
    } catch (error) {
      logger.warn(
        { installId: install.id, externalName: external.name, error },
        "OpenAPPA battery helper could not run",
      );
      return { kind: "failed", reason: "the helper sandbox is unavailable" };
    }
    if (executed.timedOut) return { kind: "timed_out" };
    if (executed.exitCode !== 0)
      return {
        kind: "failed",
        reason: `the helper exited with status ${executed.exitCode}`,
      };
    const answer = parseJsonObject(executed.stdout);
    return answer
      ? { kind: "answered", answer }
      : { kind: "failed", reason: "the helper did not print a JSON object" };
  }
}

export const openappaHelperBridge = new OpenAppaHelperBridge();

const CONSUMER_ID = "openappa-helper-bridge";
/** The helper's own execution budget inside the container. */
const HELPER_EXEC_TIMEOUT_SECONDS = 4;
const DEADLINE = Symbol("deadline");

async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | typeof DEADLINE> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
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
