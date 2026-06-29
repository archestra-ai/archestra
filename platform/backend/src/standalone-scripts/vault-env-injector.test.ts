import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// biome-ignore lint/style/noRestrictedImports: test file for .ee module
import { escapeForShell } from "./vault-env-injector.ee";

describe("vault-env-injector import safety", () => {
  it("vault-config.ts must not import @/config to avoid crashing the vault-secrets init container", () => {
    // The vault-env-injector runs as a K8s init container BEFORE the database URL
    // is available (it's the one that fetches it from Vault). If vault-config.ts
    // imports @/config, it triggers config.ts module evaluation which calls
    // getDatabaseUrl() and throws "Database URL is not set".
    const vaultConfigSource = readFileSync(
      resolve(__dirname, "../secrets-manager/vault-config.ts"),
      "utf-8",
    );

    const hasConfigImport = /import\s+.*from\s+["']@\/config["']/.test(
      vaultConfigSource,
    );
    expect(
      hasConfigImport,
      "vault-config.ts must NOT import @/config — it would crash the vault-secrets init container which runs before DATABASE_URL is available",
    ).toBe(false);
  });
});

describe("escapeForShell", () => {
  it("should wrap simple values in single quotes", () => {
    expect(escapeForShell("hello")).toBe("'hello'");
  });

  it("should handle values with spaces", () => {
    expect(escapeForShell("hello world")).toBe("'hello world'");
  });

  it("should escape single quotes", () => {
    expect(escapeForShell("it's")).toBe("'it'\"'\"'s'");
  });

  it("should handle double quotes without escaping", () => {
    expect(escapeForShell('say "hello"')).toBe("'say \"hello\"'");
  });

  it("should handle dollar signs without expansion", () => {
    expect(escapeForShell("$HOME")).toBe("'$HOME'");
  });

  it("should handle backticks without expansion", () => {
    expect(escapeForShell("`whoami`")).toBe("'`whoami`'");
  });

  it("should handle newlines", () => {
    expect(escapeForShell("line1\nline2")).toBe("'line1\nline2'");
  });

  it("should handle empty string", () => {
    expect(escapeForShell("")).toBe("''");
  });

  it("should handle multiple single quotes", () => {
    expect(escapeForShell("a'b'c")).toBe("'a'\"'\"'b'\"'\"'c'");
  });

  it("should handle value with mixed special characters", () => {
    const value = "p@ss'w$rd";
    const escaped = escapeForShell(value);
    expect(escaped).toBe("'p@ss'\"'\"'w$rd'");
  });
});
