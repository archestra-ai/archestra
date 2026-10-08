// @vitest-environment node
import { expect, test } from "vitest";
import type { PolicyBattery } from "@/lib/openappa-batteries.query";
import { batteryCredentials } from "./battery-credentials";

const GITHUB_TOKEN = "APPA_PROVIDER_GITHUB_TOKEN";
const JEV_KEY = "APPA_PROVIDER_JEV_API_KEY";

const included = (
  name: string,
  credentials: PolicyBattery["credentials"],
): PolicyBattery => ({
  entry: `batteries/${name}/appa.toml`,
  name,
  source: "bundled",
  packageHash: null,
  status: "active",
  scope: "catalogs",
  composed: true,
  line: 1,
  servers: [],
  credentials,
  helpers: [],
});

test("an included battery shows what its composition binds, not the stored row", () => {
  const composed = {
    variable: GITHUB_TOKEN,
    key: "repo-token",
    source: "policy" as const,
    readers: ["github"],
  };
  expect(
    batteryCredentials({
      declarations: {
        batteries: [included("github", [composed])],
        credentialBindings: [{ variable: GITHUB_TOKEN, key: "stored-token" }],
      },
      name: "github",
      variables: [GITHUB_TOKEN],
    }),
  ).toEqual([composed]);
});

test("a battery not included yet takes another reader's key, then a stored binding, then none", () => {
  const composed = {
    variable: GITHUB_TOKEN,
    key: "repo-token",
    source: "policy" as const,
    readers: ["github"],
  };
  expect(
    batteryCredentials({
      declarations: {
        batteries: [included("github", [composed])],
        credentialBindings: [
          { variable: GITHUB_TOKEN, key: "stored-token" },
          { variable: JEV_KEY, key: "jev-key" },
        ],
      },
      name: "scanner",
      variables: [GITHUB_TOKEN, JEV_KEY, "APPA_PROVIDER_LINEAR_TOKEN"],
    }),
  ).toEqual([
    composed,
    { variable: JEV_KEY, key: "jev-key", source: "binding", readers: [] },
    {
      variable: "APPA_PROVIDER_LINEAR_TOKEN",
      key: null,
      source: null,
      readers: [],
    },
  ]);
});
