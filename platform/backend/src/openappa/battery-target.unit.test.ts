import type {
  BatteryExternal,
  BatteryPackage,
  BatteryTargetView,
} from "@archestra/openappa-rs";
import { describe, expect, test } from "vitest";
import {
  type DeployedBattery,
  declaredCredentials,
  deployBattery,
} from "./battery-target";

const TOKEN = "APPA_PROVIDER_ACME_TOKEN";
const REGION = "APPA_PROVIDER_ACME_REGION";

const external = (command: string): BatteryExternal => ({
  kind: "annotators",
  name: "acme.visibility",
  command: ["python3", command],
  tokenEnv: TOKEN,
});

const multiUser: BatteryTargetView = {
  policy: "multi-user policy",
  credentials: [TOKEN, REGION],
  targetCredentials: [TOKEN],
  externals: [external("visibility-multi-user.py")],
  annotators: ["acme.visibility"],
  routedAnnotators: ["acme.visibility"],
  setup: "Create an app.\nSet its token.",
};

const battery = (target?: Partial<BatteryTargetView>): BatteryPackage => ({
  name: "acme",
  description: "Acme rules",
  namespaces: ["acme"],
  annotators: [],
  routedAnnotators: [],
  base: "base policy",
  helpers: ["visibility-multi-user.py"],
  credentials: [REGION],
  externals: [],
  setup: "Set the region.",
  files: [],
  ...(target ? { multiUser: { ...multiUser, ...target } } : {}),
});

const baseOnly: DeployedBattery = {
  target: null,
  basePolicy: "base policy",
  credentials: [REGION],
  externals: [],
  annotators: [],
  routedAnnotators: [],
  setup: ["Set the region."],
};

const everyBound = () => true;

describe("deployBattery", () => {
  test("a battery with targets deploys multi-user once the sandbox runs and every credential is bound", () => {
    expect(
      deployBattery({
        battery: battery({}),
        isBound: everyBound,
        sandboxEnabled: true,
      }),
    ).toEqual({
      target: { name: "multi-user", policy: "multi-user policy" },
      basePolicy: "base policy",
      credentials: [TOKEN, REGION],
      externals: [external("visibility-multi-user.py")],
      annotators: ["acme.visibility"],
      routedAnnotators: ["acme.visibility"],
      setup: ["Create an app.", "Set its token."],
    } satisfies DeployedBattery);
  });

  test.each([
    {
      case: "without targets",
      battery: battery(),
      isBound: everyBound,
      sandboxEnabled: true,
    },
    {
      case: "with the sandbox off",
      battery: battery({}),
      isBound: everyBound,
      sandboxEnabled: false,
    },
    {
      case: "with one credential unbound",
      battery: battery({}),
      isBound: (variable: string) => variable !== TOKEN,
      sandboxEnabled: true,
    },
    {
      case: "when its multi-user target reads no credential of its own",
      battery: battery({ targetCredentials: [] }),
      isBound: everyBound,
      sandboxEnabled: true,
    },
  ])("a battery deploys its base alone $case", (params) => {
    expect(deployBattery(params)).toEqual(baseOnly);
  });
});

describe("declaredCredentials", () => {
  test("a battery with targets declares what its multi-user target reads", () => {
    expect(declaredCredentials(battery({}))).toEqual([TOKEN, REGION]);
  });

  test("a battery without targets declares what its base reads", () => {
    expect(declaredCredentials(battery())).toEqual([REGION]);
  });
});
