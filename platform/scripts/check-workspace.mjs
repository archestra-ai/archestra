#!/usr/bin/env node
// Use Node's built-in type stripping when available. Older supported Node
// versions register tsx in this process, rather than retaining a CLI parent.
if (!process.features.typescript) await import("tsx");
const workspaceChecks = await import("./check-workspace.ts");
// Without native type stripping, tsx loads this untyped package as CommonJS.
const { runWorkspaceCommand } = workspaceChecks.default ?? workspaceChecks;
process.exitCode = runWorkspaceCommand(process.argv.slice(2));
