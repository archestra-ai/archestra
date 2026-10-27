import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  type SupportedProvider,
  SupportedProviders,
} from "@archestra/shared/model-constants";
import {
  SUBSCRIPTION_CREDENTIAL_KINDS,
  type SubscriptionCredentialKind,
} from "@archestra/shared/subscription-credentials";
import ts from "typescript";
import { describe, expect, test } from "vitest";

interface ClientVersionWorkflowTarget {
  packageScript: string;
  scriptFile: string;
  workflowStepId: string;
  identifier: string;
  sourceFiles: readonly string[];
}

/**
 * Exhaustive registry of emulated upstream client/editor version constants per
 * LLM provider.
 *
 * Adding a new `SupportedProvider` requires an explicit entry here:
 * - If the provider (or its subscription/OAuth flow) sends an upstream client,
 *   CLI, or editor version in headers or query params that upstream endpoints
 *   gate models or access on, extract a top-level `const <NAME>_VERSION = "X.Y.Z"`
 *   constant, add an `update-*-client-version.mjs` script using
 *   `scripts/client-version-constant.mjs`, wire it into
 *   `.github/workflows/update-client-versions.yml`, and list the target here.
 * - If the provider uses standard API keys / SDK requests with no emulated
 *   upstream client version, set its entry to `[]`.
 */
const PROVIDER_CLIENT_VERSION_WORKFLOW_TARGETS = {
  openai: [
    {
      packageScript: "update:codex-models-client-version",
      scriptFile: "update-codex-models-client-version.mjs",
      workflowStepId: "codex",
      identifier: "CODEX_MODELS_CLIENT_VERSION",
      sourceFiles: ["src/routes/chat/model-fetchers/openai.ts"],
    },
  ],
  xai: [
    {
      packageScript: "update:grok-client-version",
      scriptFile: "update-grok-client-version.mjs",
      workflowStepId: "grok",
      identifier: "GROK_CLI_CLIENT_VERSION",
      sourceFiles: ["src/services/xai-subscription-token.ts"],
    },
  ],
  "github-copilot": [
    {
      packageScript: "update:vscode-client-version",
      scriptFile: "update-vscode-client-version.mjs",
      workflowStepId: "vscode",
      identifier: "GITHUB_COPILOT_VSCODE_VERSION",
      sourceFiles: [
        "src/services/github-copilot-token.ts",
        "src/services/agent-connection-setup/agents/copilot-cli.ts",
      ],
    },
    {
      packageScript: "update:copilot-chat-client-version",
      scriptFile: "update-copilot-chat-client-version.mjs",
      workflowStepId: "copilot-chat",
      identifier: "GITHUB_COPILOT_CHAT_VERSION",
      sourceFiles: ["src/services/github-copilot-token.ts"],
    },
  ],
  gemini: [],
  anthropic: [],
  bedrock: [],
  cohere: [],
  cerebras: [],
  mistral: [],
  perplexity: [],
  groq: [],
  openrouter: [],
  vllm: [],
  ollama: [],
  "ollama-native": [],
  zhipuai: [],
  deepseek: [],
  minimax: [],
  kimi: [],
  azure: [],
  "microsoft-365-copilot": [],
  archestra: [],
  voyage: [],
  jev: [],
} as const satisfies Record<
  SupportedProvider,
  readonly ClientVersionWorkflowTarget[]
>;

/**
 * Exhaustive registry of subscription credentials and the client-version
 * updater scripts they depend on. Subscription auth modes frequently emulate a
 * first-party CLI or editor identity, so a new `SubscriptionCredentialKind`
 * must explicitly declare its updater scripts (or `[]` when standard OAuth
 * needs no client version header).
 */
const SUBSCRIPTION_CLIENT_VERSION_WORKFLOW_TARGETS = {
  chatgpt: ["update:codex-models-client-version"],
  "github-copilot": [
    "update:vscode-client-version",
    "update:copilot-chat-client-version",
  ],
  "microsoft-365-copilot": [],
  "x-premium": ["update:grok-client-version"],
} as const satisfies Record<SubscriptionCredentialKind, readonly string[]>;

const backendRoot = path.resolve(import.meta.dirname, "../..");
const repoRoot = path.resolve(backendRoot, "../..");
const workflowPath = path.join(
  repoRoot,
  ".github/workflows/update-client-versions.yml",
);

const allTargets: readonly ClientVersionWorkflowTarget[] = Object.values(
  PROVIDER_CLIENT_VERSION_WORKFLOW_TARGETS,
).flat();

describe("client-version update workflow guardrails", () => {
  test("covers every SupportedProvider and SubscriptionCredentialKind", () => {
    expect(
      Object.keys(PROVIDER_CLIENT_VERSION_WORKFLOW_TARGETS).sort(),
    ).toEqual([...SupportedProviders].sort());
    expect(
      Object.keys(SUBSCRIPTION_CLIENT_VERSION_WORKFLOW_TARGETS).sort(),
    ).toEqual([...SUBSCRIPTION_CREDENTIAL_KINDS].sort());

    const registeredPackageScripts = new Set(
      allTargets.map((target) => target.packageScript),
    );
    for (const scripts of Object.values(
      SUBSCRIPTION_CLIENT_VERSION_WORKFLOW_TARGETS,
    )) {
      for (const script of scripts) {
        expect(registeredPackageScripts.has(script)).toBe(true);
      }
    }
  });

  test("registers every scripts/update-*-client-version.mjs script in package.json, knip, and the workflow", () => {
    const scriptsDir = path.join(backendRoot, "scripts");
    const updaterScriptsOnDisk = readdirSync(scriptsDir)
      .filter((name) => /^update-.*-client-version\.mjs$/.test(name))
      .sort();
    const registeredScriptFiles = allTargets
      .map((target) => target.scriptFile)
      .sort();
    expect(updaterScriptsOnDisk).toEqual(registeredScriptFiles);

    const packageJson = JSON.parse(
      readFileSync(path.join(backendRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const knipSource = readFileSync(
      path.join(backendRoot, "knip.config.ts"),
      "utf8",
    );
    const workflowSource = readFileSync(workflowPath, "utf8");

    for (const target of allTargets) {
      expect(packageJson.scripts[target.packageScript]).toBe(
        `node scripts/${target.scriptFile}`,
      );
      expect(knipSource).toContain(`"scripts/${target.scriptFile}!"`);
      expect(workflowSource).toMatch(
        new RegExp(`\\bid:\\s*${escapeRegExp(target.workflowStepId)}\\b`),
      );
      expect(workflowSource).toContain(
        `pnpm --dir backend ${target.packageScript}`,
      );
      expect(workflowSource).toContain(
        `steps.${target.workflowStepId}.outcome == 'failure'`,
      );

      for (const relativeSourceFile of target.sourceFiles) {
        const repoRelativePath = `platform/backend/${relativeSourceFile}`;
        expect(workflowSource).toContain(repoRelativePath);
        assertTopLevelSemverConst(
          path.join(backendRoot, relativeSourceFile),
          target.identifier,
        );
      }
    }
  });

  test("leaves no untracked client-version constants or hardcoded editor/client version headers in provider modules", () => {
    const trackedPairs = new Set(
      allTargets.flatMap((target) =>
        target.sourceFiles.map(
          (sourceFile) => `${sourceFile}#${target.identifier}`,
        ),
      ),
    );

    const scanDirectories = [
      "src/services",
      "src/routes/chat/model-fetchers",
      "src/routes/proxy",
      "src/clients",
    ];
    const untrackedConstants: string[] = [];
    const inlineHardcodedVersionLiterals: string[] = [];

    for (const directory of scanDirectories) {
      for (const absoluteFile of walkProductionTsFiles(
        path.join(backendRoot, directory),
      )) {
        const relativeFile = path
          .relative(backendRoot, absoluteFile)
          .replaceAll(path.sep, "/");
        const sourceText = readFileSync(absoluteFile, "utf8");
        const sourceFile = ts.createSourceFile(
          absoluteFile,
          sourceText,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        );

        for (const statement of sourceFile.statements) {
          if (!ts.isVariableStatement(statement)) continue;
          for (const declaration of statement.declarationList.declarations) {
            if (
              !ts.isIdentifier(declaration.name) ||
              !declaration.initializer ||
              !ts.isStringLiteral(declaration.initializer)
            ) {
              continue;
            }
            const name = declaration.name.text;
            const value = declaration.initializer.text;
            if (
              /^\d+\.\d+\.\d+$/.test(value) &&
              /(?:CLIENT|EDITOR|PLUGIN|VSCODE|CHAT|CLI)_VERSION$/.test(name)
            ) {
              const key = `${relativeFile}#${name}`;
              if (!trackedPairs.has(key)) {
                untrackedConstants.push(`${key} = "${value}"`);
              }
            }
          }
        }

        const checkNode = (node: ts.Node) => {
          if (
            ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node)
          ) {
            const text = node.text;
            if (
              /(?:^|[\s'"=/])(?:vscode|copilot-chat|GitHubCopilotChat|grok-build)\/\d+\.\d+\.\d+/.test(
                text,
              ) ||
              /[?&]client_version=\d+\.\d+\.\d+/.test(text)
            ) {
              inlineHardcodedVersionLiterals.push(
                `${relativeFile}: ${JSON.stringify(text)}`,
              );
            }
          }
          ts.forEachChild(node, checkNode);
        };
        checkNode(sourceFile);
      }
    }

    expect(untrackedConstants).toEqual([]);
    expect(inlineHardcodedVersionLiterals).toEqual([]);
  });
});

function assertTopLevelSemverConst(sourcePath: string, identifier: string) {
  const sourceText = readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = sourceFile.statements.flatMap((statement) =>
    ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.filter(
          (declaration) =>
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === identifier,
        )
      : [],
  );
  expect(declarations).toHaveLength(1);
  const initializer = declarations[0]?.initializer;
  expect(initializer && ts.isStringLiteral(initializer)).toBe(true);
  if (initializer && ts.isStringLiteral(initializer)) {
    expect(initializer.text).toMatch(/^\d+\.\d+\.\d+$/);
  }
}

function* walkProductionTsFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkProductionTsFiles(entryPath);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test-helpers.ts")
    ) {
      yield entryPath;
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
