import { expect, test } from "vitest";
import { commitScope } from "../../../scripts/commit-scope";

const packages = [
  { dir: "backend", name: "@backend" },
  { dir: "frontend", name: "@frontend" },
  { dir: "shared", name: "@archestra/shared" },
  { dir: "archestra-rs/router-rs", name: "@archestra/router-rs" },
];

function scope(...stagedPaths: string[]) {
  return commitScope({ stagedPaths, platformPrefix: "platform/", packages });
}

test("a commit inside packages checks only those packages", () => {
  expect(
    scope(
      "platform/backend/src/server.ts",
      "platform/shared/consts.ts",
      "platform/backend/src/config.ts",
      "platform/archestra-rs/router-rs/src/lib.rs",
    ),
  ).toEqual({
    kind: "packages",
    names: ["@archestra/router-rs", "@archestra/shared", "@backend"],
  });
});

test("check configuration at the platform root checks every package", () => {
  for (const path of [
    "platform/biome.json",
    "platform/turbo.json",
    "platform/package.json",
    "platform/pnpm-lock.yaml",
    "platform/.gitignore",
    "platform/scripts/type-check.ts",
    "platform/vitest.resources.ts",
  ]) {
    expect(scope("platform/backend/src/server.ts", path)).toEqual({
      kind: "all",
    });
  }
});

test("Tilt, deployment, prose and paths outside platform/ need no workspace check", () => {
  expect(
    scope(
      "platform/dev/Tiltfile.dev",
      "platform/helm/archestra/values.yaml",
      "platform/.env.example",
      "platform/AGENTS.md",
      "docs/pages/admin/deployment/configuration.md",
      ".github/workflows/on-pull-requests.yml",
    ),
  ).toEqual({ kind: "none" });
});

test("a nested Markdown file stays with its package", () => {
  expect(scope("platform/backend/README.md")).toEqual({
    kind: "packages",
    names: ["@backend"],
  });
  expect(scope("platform/scripts/README.md")).toEqual({ kind: "all" });
});
