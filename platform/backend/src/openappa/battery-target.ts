import type { BatteryExternal, BatteryPackage } from "@archestra/openappa-rs";
import type { BatteryTargetName } from "@/types/openappa-batteries";
import { type ToolEntry, toolEntries, toolHeaderLines } from "./policy-text";

/** A battery as this deployment composes it: its base, and the target before it. */
export type DeployedBattery = {
  /** Null when the battery deploys as its base alone. */
  target: { name: BatteryTargetName; policy: string } | null;
  basePolicy: string;
  credentials: string[];
  externals: BatteryExternal[];
  annotators: string[];
  routedAnnotators: string[];
  setup: string[];
};

/**
 * The target a battery deploys as: multi-user when it declares one that reads
 * a credential of its own, the deployment can run its helpers, and every
 * credential it reads is bound; otherwise its base alone.
 */
export function deployBattery(params: {
  battery: BatteryPackage;
  isBound: (variable: string) => boolean;
  sandboxEnabled: boolean;
}): DeployedBattery {
  const { battery, isBound, sandboxEnabled } = params;
  const multiUser = battery.multiUser;
  const deploysMultiUser =
    multiUser !== undefined &&
    sandboxEnabled &&
    multiUser.targetCredentials.length > 0 &&
    multiUser.credentials.every(isBound);
  return deployedFromRow(battery, deploysMultiUser ? "multi-user" : null);
}

/** Every credential a deployment of the battery may read, whichever target it takes. */
export function declaredCredentials(battery: BatteryPackage): string[] {
  return battery.multiUser?.credentials ?? battery.credentials;
}

/** What the battery deploys as here once every credential it reads is bound. */
export function prospectiveDeployment(
  battery: BatteryPackage,
  sandboxEnabled: boolean,
): DeployedBattery {
  return deployBattery({ battery, isBound: () => true, sandboxEnabled });
}

export type DeployedFile = { text: string; firstLine: number };

/** A line of one deployed file, as a line of the deployment's shown text. */
export function shownLine(
  file: Pick<DeployedFile, "firstLine">,
  line: number | null | undefined,
): number | null {
  return line == null ? null : file.firstLine - 1 + line;
}

/**
 * The policy files a deployment composes, target first, each with the line it
 * starts at in the one text the host shows for it (`deployedSource`).
 */
export function deployedFiles(deployed: DeployedBattery): DeployedFile[] {
  const texts = deployed.target
    ? [deployed.target.policy, deployed.basePolicy]
    : [deployed.basePolicy];
  let firstLine = 1;
  return texts.map((text) => {
    const file = { text, firstLine };
    firstLine += terminated(text).split("\n").length - 1;
    return file;
  });
}

/**
 * A deployment's tool rules in compose order, each with the line it starts at
 * in the deployment's shown text; a target's rule shadows its base's.
 */
export function effectiveToolRules(
  files: DeployedFile[],
): Array<{ entry: ToolEntry; line: number | null }> {
  const seen = new Set<string>();
  return files.flatMap(({ text, firstLine }) => {
    const entries = toolEntries(text);
    const lines = toolHeaderLines(text);
    return entries.flatMap((entry, index) => {
      if (seen.has(entry.name)) return [];
      seen.add(entry.name);
      const line = lines.length === entries.length ? lines[index] : undefined;
      return [
        { entry, line: line === undefined ? null : firstLine - 1 + line },
      ];
    });
  });
}

/** The text the host shows for a deployment: its policy files in compose order. */
export function deployedSource(deployed: DeployedBattery): string {
  return deployed.target
    ? deployedFiles(deployed)
        .map((file) => terminated(file.text))
        .join("")
    : deployed.basePolicy;
}

/** The battery as it deploys for a target already chosen; one it lacks deploys its base. */
export function deployedFromRow(
  battery: BatteryPackage,
  target: BatteryTargetName | null,
): DeployedBattery {
  const multiUser = battery.multiUser;
  if (target === null || multiUser === undefined)
    return {
      target: null,
      basePolicy: battery.base,
      credentials: battery.credentials,
      externals: battery.externals,
      annotators: battery.annotators,
      routedAnnotators: battery.routedAnnotators,
      setup: setupSteps(battery.setup),
    };
  return {
    target: { name: target, policy: multiUser.policy },
    basePolicy: battery.base,
    credentials: multiUser.credentials,
    externals: multiUser.externals,
    annotators: multiUser.annotators,
    routedAnnotators: multiUser.routedAnnotators,
    setup: setupSteps(multiUser.setup),
  };
}

function terminated(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** The native package joins its one-line setup steps with newlines. */
function setupSteps(setup: string | undefined): string[] {
  return setup?.split("\n") ?? [];
}
