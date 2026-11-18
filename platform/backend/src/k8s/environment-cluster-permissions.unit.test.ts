import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, test } from "vitest";
import { ENVIRONMENT_CLUSTER_PERMISSIONS } from "./environment-cluster-permissions";

/**
 * The chart rules that serve only the platform's own cluster, as
 * `<apiGroup>/<resource>`, and why an environment's cluster has no use for
 * them.
 */
const PLATFORM_CLUSTER_ONLY_RULES: Record<string, string> = {
  "/serviceaccounts":
    "read for the Agent Runtime image prefetch, which runs only in the platform's cluster",
  "apps/daemonsets":
    "the MCP image pre-puller and the image prefetch run only in the platform's cluster",
  "batch/jobs": "nothing the platform deploys into an environment is a Job",
  "extensions.agents.x-k8s.io/sandboxtemplates":
    "warm spares are kept only in the platform's cluster",
  "extensions.agents.x-k8s.io/sandboxwarmpools":
    "warm spares are kept only in the platform's cluster",
};

const HELM_DIRECTORY = path.resolve(__dirname, "../../../helm");

interface HelmRule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
}

/** The RBAC rules a chart's named template holds, read from its source. */
function rulesOfTemplate(file: string, name: string): HelmRule[] {
  const source = readFileSync(path.join(HELM_DIRECTORY, file), "utf8");
  const start = source.indexOf(`{{- define "${name}" -}}`);
  if (start === -1) throw new Error(`No template ${name} in ${file}`);
  const body = source.slice(
    source.indexOf("\n", start),
    source.indexOf("{{- end }}", start),
  );
  return load(body) as HelmRule[];
}

/** Rules as `<apiGroup>/<resource>` -> sorted verbs, however they are grouped. */
function permissionsOf(rules: HelmRule[]): Record<string, string[]> {
  const permissions: Record<string, string[]> = {};
  for (const rule of rules) {
    for (const apiGroup of rule.apiGroups) {
      for (const resource of rule.resources) {
        permissions[`${apiGroup}/${resource}`] = [...rule.verbs].sort();
      }
    }
  }
  return permissions;
}

const tablePermissions = Object.fromEntries(
  ENVIRONMENT_CLUSTER_PERMISSIONS.map((permission) => [
    `${permission.apiGroup}/${permission.resource}`,
    [...permission.verbs].sort(),
  ]),
);

describe("the permissions the platform uses in an environment's own cluster", () => {
  const platformChart = permissionsOf(
    rulesOfTemplate(
      "archestra/templates/_helpers.tpl",
      "archestra-platform.mcpManagerRules",
    ),
  );

  test("are what the platform's chart grants in its own cluster, less what only serves that cluster, plus the port-forward", () => {
    const expected = { ...platformChart };
    for (const platformOnly of Object.keys(PLATFORM_CLUSTER_ONLY_RULES)) {
      delete expected[platformOnly];
    }
    expected["/pods/portforward"] = ["create", "get"];

    expect(tablePermissions).toEqual(expected);
  });

  test("leave out only rules the platform's chart actually has", () => {
    for (const platformOnly of Object.keys(PLATFORM_CLUSTER_ONLY_RULES)) {
      expect(platformChart).toHaveProperty([platformOnly]);
    }
  });

  test("are exactly what the archestra-workloads chart grants", () => {
    expect(
      permissionsOf(
        rulesOfTemplate(
          "archestra-workloads/templates/_helpers.tpl",
          "archestra-workloads.rules",
        ),
      ),
    ).toEqual(tablePermissions);
  });
});
