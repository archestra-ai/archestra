#!/usr/bin/env node
// Checks that the backend's TypeScript projects (the references of
// tsconfig.json) check every backend file exactly once: a file in no project
// is never type-checked, and one in two is checked twice. A source file must
// be in the project its layer names (layers.mjs), every project must include
// the ambient declarations, which no project emits, and every project must
// declare its peak (TYPE_CHECK_PROJECT_PEAK_BYTES), which the heavy-command
// lane reads to decide whether the dev stack's servers make room for it. A
// test project must reference every source project: the compiler would check
// an unreferenced project's files from source inside it, without an error.
//
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/check-projects.mjs
// (the projects are the ones `pnpm type-check` builds, read by its own code;
// Node strips that module's types, and the flag silences its note that
// platform/ has no package type)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { solutionBuildOrder } from "../../scripts/type-check-solution.ts";
import { TYPE_CHECK_PROJECT_PEAK_BYTES } from "../../vitest.resources.ts";
import { layerOf } from "../layers.mjs";

const backendDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const problems = checkProjects(backendDir);
if (problems.length > 0) {
  console.error(
    `${problems.length} problem(s) with the backend's TypeScript projects (tsconfig.json):\n${problems.map((problem) => `  ${problem}`).join("\n")}`,
  );
  process.exit(1);
}
console.log("Every backend file is in exactly one TypeScript project.");

// ===== Internal helpers =====

/** The problems, one line each; none when the projects cover the backend. */
function checkProjects(root) {
  const solution = solutionBuildOrder(path.join(root, "tsconfig.json"));
  if (!solution) return ["tsconfig.json is not a solution of projects"];
  const declared = TYPE_CHECK_PROJECT_PEAK_BYTES.backend ?? {};
  const problems = solution
    .map((project) => path.relative(root, project.config).split(path.sep).join("/"))
    .filter((name) => declared[name] === undefined)
    .map(
      (name) =>
        `${name} declares no peak: add its measured peak to TYPE_CHECK_PROJECT_PEAK_BYTES (vitest.resources.ts)`,
    );
  const sourceProjects = solution
    .map((project) => project.config)
    .filter((config) => parseProject(config).options.composite);
  const relative = (config) =>
    path.relative(root, config).split(path.sep).join("/");
  for (const project of solution) {
    if (sourceProjects.includes(project.config)) continue;
    for (const source of sourceProjects) {
      if (!project.references.includes(source)) {
        problems.push(
          `${relative(project.config)} does not reference ${relative(source)}`,
        );
      }
    }
  }
  const projects = solution
    .map((project) => project.config)
    // Other packages' projects check their own files.
    .filter((config) => path.dirname(config) === root);
  const owners = new Map();
  const ambient = backendFiles(root, "src/ambient");
  for (const config of projects) {
    const name = path.basename(config);
    const files = new Set(projectFiles(config, root));
    for (const file of ambient) {
      if (!files.has(file)) problems.push(`${name} does not include ${file}`);
    }
    for (const file of files) {
      if (ambient.includes(file)) continue;
      owners.set(file, [...(owners.get(file) ?? []), name]);
    }
  }
  const universe = [
    ...backendFiles(root, "src").filter(
      (file) => file.endsWith(".ts") && !ambient.includes(file),
    ),
    ...fs
      .readdirSync(root)
      .filter((file) => file.endsWith(".config.ts"))
      .sort(),
  ];
  for (const file of universe) {
    const owner = owners.get(file) ?? [];
    if (owner.length === 0) {
      problems.push(
        `${file} is in no project: add it to the tsconfig that should check it`,
      );
      continue;
    }
    if (owner.length > 1) {
      problems.push(`${file} is in ${owner.length} projects: ${owner.join(", ")}`);
      continue;
    }
    const layer = layerOf(file);
    if (layer && owner[0] !== layer.project) {
      problems.push(
        `${file} is in ${owner[0]}, but its layer ${layer.name} is checked by ${layer.project} (layers.mjs)`,
      );
    }
  }
  return problems;
}

/** A project's input files that are inside the backend, relative to it. */
function projectFiles(config, root) {
  return parseProject(config)
    .fileNames
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .filter((file) => !file.startsWith("../") && file.endsWith(".ts"));
}

/** A tsconfig as the compiler reads it: options, extends and file lists resolved. */
function parseProject(config) {
  const parsed = ts.getParsedCommandLineOfConfigFile(config, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      );
    },
  });
  if (!parsed) throw new Error(`Cannot read ${config}`);
  return parsed;
}

/** Every file under a backend directory, relative to the backend, sorted. */
function backendFiles(root, directory) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];
  return fs
    .readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(root, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    )
    .sort();
}
