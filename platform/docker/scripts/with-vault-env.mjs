// Runs a command with the secrets the Vault injector init container wrote to
// /vault/secrets/env added to its environment, then becomes that command. The
// Helm chart wraps the platform, worker and migration containers in it when
// Vault secret injection is on. Plain Node, so it also works in the slim image,
// which has no shell to `source` the file.
//
// Usage: node /app/with-vault-env.mjs <program> [args...]
//
// The file holds shell assignments, `KEY='value'` with each embedded single
// quote written as '"'"' (vault-env-injector.ee.ts). Values may span lines.
// A missing file adds nothing, as `[ -f … ] && .` did.

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ===
// Public interface
// ===

/**
 * The variables in a file of shell assignments made of single-quoted,
 * double-quoted and bare words. Throws on anything else, so a malformed file
 * stops the container instead of starting it without its secrets.
 */
export function parseShellAssignments(text) {
  const variables = {};
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i += 1;
      continue;
    }
    if (text[i] === "#") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(text.slice(i));
    if (!name) throw new Error(`expected NAME=value at offset ${i}`);
    i += name[0].length;
    let value = "";
    while (i < text.length && !/\s/.test(text[i])) {
      const quote = text[i];
      if (quote === "'" || quote === '"') {
        const end = text.indexOf(quote, i + 1);
        if (end === -1) throw new Error(`unterminated ${quote} at offset ${i}`);
        const word = text.slice(i + 1, end);
        if (quote === '"' && /[\\$`]/.test(word)) {
          throw new Error(`unsupported expansion in "..." at offset ${i}`);
        }
        value += word;
        i = end + 1;
      } else if (/[\\$`;&|<>()]/.test(quote)) {
        throw new Error(`unsupported character ${quote} at offset ${i}`);
      } else {
        value += quote;
        i += 1;
      }
    }
    variables[name[0].slice(0, -1)] = value;
  }
  return variables;
}

/** The absolute path of `program`, looked up on PATH unless it has a slash. */
export function resolveProgram(program, envPath) {
  if (program.includes("/")) return program;
  for (const directory of (envPath ?? "").split(":")) {
    if (!directory) continue;
    const candidate = path.join(directory, program);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`${program}: not found on PATH`);
}

// ===
// Internal helpers
// ===

const SECRETS_FILE = "/vault/secrets/env";

async function main() {
  const [program, ...args] = process.argv.slice(2);
  if (!program) {
    console.error("usage: with-vault-env.mjs <program> [args...]");
    process.exit(2);
  }
  const env = { ...process.env };
  if (existsSync(SECRETS_FILE)) {
    try {
      Object.assign(env, parseShellAssignments(readFileSync(SECRETS_FILE, "utf8")));
    } catch (error) {
      console.error(`${SECRETS_FILE}: ${error.message}`);
      process.exit(1);
    }
  }
  const { replaceProcess } = await import("/app/backend/scripts/start-production.mjs");
  replaceProcess(resolveProgram(program, env.PATH), args, env);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
