import type { BatteryExternal, BatteryPackage } from "@archestra/openappa-rs";

/** The only target a hosted deployment composes; it never deploys single-user. */
type BatteryTargetName = "multi-user";

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
 * The target a battery deploys as: multi-user when it declares one, the
 * deployment can run its helpers, and every credential it reads is bound;
 * otherwise its base alone.
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
    multiUser.credentials.length > 0 &&
    multiUser.credentials.every(isBound);
  return deployedFromRow(battery, deploysMultiUser ? "multi-user" : null);
}

/** Every credential a deployment of the battery may read, whichever target it takes. */
export function declaredCredentials(battery: BatteryPackage): string[] {
  return battery.multiUser?.credentials ?? battery.credentials;
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

/** The native package joins its one-line setup steps with newlines. */
function setupSteps(setup: string | undefined): string[] {
  return setup?.split("\n") ?? [];
}
