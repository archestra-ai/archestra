import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  type AddonTarget,
  addonCandidates,
  ensureNativeAddons,
  missingAddons,
  type NativeAddonsResult,
  nativeAddonCrates,
  prebuiltKey,
  staleAddons,
} from "./native-addons";

// ensureNativeAddons as vitest.config.ts calls it, in a small git checkout of
// its own, against a stand-in for scripts/napi-prebuilt.mjs that records its
// arguments and either installs what it was asked for, installs nothing, or
// stalls.
const PLATFORM_DIR = path.resolve(__dirname, "../../..");
const INSTALLER = path.join(PLATFORM_DIR, "scripts/napi-prebuilt.mjs");
const CRATES = [
  "app-runtime-rs",
  "image-rs",
  "openappa-rs",
  "router-rs",
  "sandbox-rs",
];
const LINUX: AddonTarget = { platform: "linux", arch: "x64", musl: false };

describe("ensureNativeAddons", () => {
  let repo: Checkout | undefined;
  afterEach(() => {
    if (repo) rmSync(repo.dir, { recursive: true, force: true });
    repo = undefined;
  });

  test("the crates are the backend's native dependencies, the ones the installer knows", () => {
    const crates = nativeAddonCrates(path.resolve(__dirname, "../.."));
    expect(crates).toEqual(CRATES);
    const source = readFileSync(INSTALLER, "utf8");
    const packages = /const PACKAGES = \[([^\]]+)\]/.exec(source)?.[1];
    expect(
      packages?.match(/"[^"]+"/g)?.map((name) => JSON.parse(name)),
    ).toEqual(crates);
  });

  test("the key is the one the installer computes", () => {
    const expected = execFileSync(process.execPath, [INSTALLER, "--key"], {
      encoding: "utf8",
    }).trim();
    expect(prebuiltKey(path.join(PLATFORM_DIR, "archestra-rs"))).toBe(expected);
  });

  test("a prepared checkout runs nothing and says nothing", () => {
    repo = checkout();
    repo.install(CRATES, repo.key);
    const run = repo.run("installs");
    expect(run.result).toEqual({ outcome: "present", missing: [] });
    expect(run.lines).toEqual([]);
    expect(repo.calls()).toEqual([]);
  });

  test("addons built here, without a stamp, are taken as they are", () => {
    repo = checkout();
    repo.install(CRATES);
    const run = repo.run("installs");
    expect(run.result.outcome).toBe("present");
    expect(repo.calls()).toEqual([]);
  });

  test("a missing addon has the installer put the published ones in place", () => {
    repo = checkout();
    repo.install(["app-runtime-rs", "image-rs", "sandbox-rs"], repo.key);
    const run = repo.run("installs");
    expect(run.result).toEqual({ outcome: "installed", missing: [] });
    expect(run.lines).toEqual([]);
    // One call, for every crate: the installer installs all of them from one
    // download, however many were asked for.
    expect(repo.calls()).toEqual([CRATES]);
    expect(missingAddons(repo.rustDir, CRATES, LINUX)).toEqual([]);
  });

  test("addons stamped for another tree are refreshed on a clean tree", () => {
    repo = checkout();
    repo.install(
      CRATES,
      "0000000000000000000000000000000000000000-000000000000-000000000000-000000000000",
    );
    expect(staleAddons(repo.rustDir, CRATES, repo.key)).toEqual(CRATES);
    const run = repo.run("installs");
    expect(run.result).toEqual({ outcome: "installed", missing: [] });
    expect(repo.calls()).toEqual([CRATES]);
    expect(staleAddons(repo.rustDir, CRATES, repo.key)).toEqual([]);
  });

  test("addons stamped for another tree stay while archestra-rs has local changes", () => {
    repo = checkout();
    repo.install(CRATES, "stale-key");
    writeFileSync(path.join(repo.rustDir, "router-rs", "lib.rs"), "// edit\n");
    const run = repo.run("installs");
    expect(run.result).toEqual({ outcome: "present", missing: [] });
    expect(run.lines).toEqual([]);
    expect(repo.calls()).toEqual([]);
  });

  test("an installer that cannot install leaves the tests to run and says how to build", () => {
    repo = checkout();
    repo.install(["app-runtime-rs"], repo.key);
    const run = repo.run("fails");
    expect(run.result).toEqual({
      outcome: "unavailable",
      missing: ["image-rs", "openappa-rs", "router-rs", "sandbox-rs"],
    });
    expect(repo.calls()).toHaveLength(1);
    expect(run.lines).toHaveLength(1);
    expect(run.lines[0]).toContain(
      "no addon for image-rs, openappa-rs, router-rs, sandbox-rs",
    );
    expect(run.lines[0]).toContain("Unable to load @archestra/<crate>");
    expect(run.lines[0]).toContain(
      "pnpm --dir archestra-rs/openappa-rs build:dev",
    );
    expect(run.lines[0]).not.toContain("app-runtime-rs build:dev");
  });

  test("a failed install is not retried for ten minutes, unless the tree changes", () => {
    repo = checkout();
    let clock = 1_000_000;
    const first = repo.run("fails", { now: () => clock });
    expect(first.result.outcome).toBe("unavailable");
    clock += 9 * 60_000;
    const soon = repo.run("installs", { now: () => clock });
    expect(soon.result.outcome).toBe("unavailable");
    expect(soon.lines[0]).toContain("failed 9 min ago");
    expect(repo.calls()).toHaveLength(1);
    clock += 2 * 60_000;
    const later = repo.run("installs", { now: () => clock });
    expect(later.result.outcome).toBe("installed");
    expect(repo.calls()).toHaveLength(2);
    // A new tree is a new chance at once.
    repo.remove(CRATES);
    repo.run("fails", { now: () => clock });
    repo.commit("rust change", {
      "platform/archestra-rs/image-rs/lib.rs": "// new\n",
    });
    const changed = repo.run("installs", { now: () => clock });
    expect(changed.result.outcome).toBe("installed");
    expect(repo.calls()).toHaveLength(4);
  });

  test("a stalled installer is stopped and reported, and the tests still run", () => {
    repo = checkout();
    const run = repo.run("stalls", { timeoutMs: 500 });
    expect(run.result.outcome).toBe("unavailable");
    expect(run.result.missing).toEqual(CRATES);
    expect(run.lines[0]).toBe(
      "native addons: the prebuilt installer gave up after 0.5 s",
    );
    expect(run.lines[1]).toContain(
      "no addon for app-runtime-rs, image-rs, openappa-rs, router-rs, sandbox-rs",
    );
  });

  test("ARCHESTRA_DEV_NAPI_PREBUILT=false skips the installer and only says what is missing", () => {
    repo = checkout();
    repo.install(
      ["app-runtime-rs", "image-rs", "openappa-rs", "router-rs"],
      repo.key,
    );
    const run = repo.run("installs", {
      env: { ARCHESTRA_DEV_NAPI_PREBUILT: "false" },
    });
    expect(run.result).toEqual({
      outcome: "disabled",
      missing: ["sandbox-rs"],
    });
    expect(repo.calls()).toEqual([]);
    expect(run.lines).toHaveLength(1);
    expect(run.lines[0]).toContain("no addon for sandbox-rs");
    expect(run.lines[0]).toContain("ARCHESTRA_DEV_NAPI_PREBUILT=false");
  });

  test("a second evaluation in the same process reuses the answer: one install, one message", () => {
    repo = checkout();
    const cache = new Map<string, NativeAddonsResult>();
    const first = repo.run("fails", { cache });
    const second = repo.run("fails", { cache });
    expect(second.result).toBe(first.result);
    expect(repo.calls()).toHaveLength(1);
    expect(first.lines).toHaveLength(1);
    expect(second.lines).toHaveLength(0);
  });

  test("an addon counts only for the target the loader would pick it on", () => {
    expect(addonCandidates("openappa-rs", LINUX)).toEqual([
      "openappa_rs.linux-x64-gnu.node",
      "index.linux-x64-gnu.node",
      "openappa_rs.node",
      "index.node",
    ]);
    expect(
      addonCandidates("image-rs", {
        platform: "linux",
        arch: "arm64",
        musl: true,
      }),
    ).toEqual([
      "image_rs.linux-arm64-musl.node",
      "index.linux-arm64-musl.node",
      "image_rs.node",
      "index.node",
    ]);
    repo = checkout();
    writeFileSync(
      path.join(repo.rustDir, "image-rs", "index.darwin-arm64.node"),
      "",
    );
    writeFileSync(
      path.join(repo.rustDir, "router-rs", "index.linux-x64-gnu.node.tmp"),
      "",
    );
    writeFileSync(path.join(repo.rustDir, "sandbox-rs", "sandbox_rs.node"), "");
    expect(missingAddons(repo.rustDir, CRATES, LINUX)).toEqual([
      "app-runtime-rs",
      "image-rs",
      "openappa-rs",
      "router-rs",
    ]);
    expect(
      missingAddons(repo.rustDir, CRATES, {
        platform: "darwin",
        arch: "arm64",
        musl: false,
      }),
    ).toEqual(["app-runtime-rs", "openappa-rs", "router-rs"]);
  });

  test("outside a git checkout an addon that exists is taken as it is", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "native-addons-plain-"));
    try {
      const rustDir = path.join(dir, "archestra-rs");
      for (const crate of CRATES) {
        mkdirSync(path.join(rustDir, crate), { recursive: true });
        writeFileSync(
          path.join(rustDir, crate, "index.linux-x64-gnu.node"),
          "",
        );
        writeFileSync(
          path.join(rustDir, crate, ".napi-prebuilt"),
          "some-key 0\n",
        );
      }
      mkdirSync(path.join(dir, "backend"));
      writeFileSync(path.join(dir, "backend/package.json"), manifest());
      expect(prebuiltKey(rustDir)).toBeUndefined();
      const lines: string[] = [];
      const result = ensureNativeAddons({
        backendDir: path.join(dir, "backend"),
        rustDir,
        installer: "/nonexistent",
        env: {},
        log: (line) => lines.push(line),
        target: LINUX,
        cache: new Map(),
      });
      expect(result).toEqual({ outcome: "present", missing: [] });
      expect(lines).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

type Checkout = {
  dir: string;
  rustDir: string;
  key: string;
  /** Put an addon in place for the named crates, stamped with a key or not. */
  install: (crates: readonly string[], stampKey?: string) => void;
  remove: (crates: readonly string[]) => void;
  commit: (message: string, files: Record<string, string>) => void;
  run: (
    behaviour: "installs" | "fails" | "stalls",
    options?: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      cache?: Map<string, NativeAddonsResult>;
      now?: () => number;
    },
  ) => { result: ReturnType<typeof ensureNativeAddons>; lines: string[] };
  calls: () => string[][];
};

/**
 * A git checkout with the files the key is made of, a crate directory per
 * addon, and a backend package.json naming them.
 */
function checkout(): Checkout {
  const dir = mkdtempSync(path.join(tmpdir(), "native-addons-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  const files: Record<string, string> = {
    // As platform/.gitignore: the addons and the installer's stamps are
    // untracked without making the tree look modified.
    "platform/.gitignore": "*.node\n*.node.tmp\n.napi-prebuilt*\n",
    "platform/rust-toolchain.toml": '[toolchain]\nchannel = "1.93.0"\n',
    "platform/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    ".github/workflows/napi-dev-cache.yml": "name: napi-dev-cache\n",
    "platform/backend/package.json": manifest(),
  };
  for (const crate of CRATES) {
    files[`platform/archestra-rs/${crate}/package.json`] =
      `{"name":"@archestra/${crate}"}\n`;
  }
  const commit = (message: string, changes: Record<string, string>) => {
    for (const [file, content] of Object.entries(changes)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), content);
    }
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };
  commit("init", files);
  const rustDir = path.join(dir, "platform/archestra-rs");
  const checkoutKey = () => {
    const key = prebuiltKey(rustDir);
    if (!key) throw new Error("the checkout has no key");
    return key;
  };
  const installer = path.join(dir, "napi-prebuilt.mjs");
  return {
    dir,
    rustDir,
    get key() {
      return checkoutKey();
    },
    install(crates, stampKey) {
      for (const crate of crates) {
        writeFileSync(
          path.join(rustDir, crate, "index.linux-x64-gnu.node"),
          "",
        );
        if (stampKey) {
          writeFileSync(
            path.join(rustDir, crate, ".napi-prebuilt"),
            `${stampKey} 0\n`,
          );
        }
      }
    },
    remove(crates) {
      for (const crate of crates) {
        rmSync(path.join(rustDir, crate, "index.linux-x64-gnu.node"), {
          force: true,
        });
        rmSync(path.join(rustDir, crate, ".napi-prebuilt"), { force: true });
      }
    },
    commit,
    run(behaviour, options = {}) {
      stub(installer, dir, behaviour, checkoutKey());
      const lines: string[] = [];
      const result = ensureNativeAddons({
        backendDir: path.join(dir, "platform/backend"),
        rustDir,
        installer,
        env: options.env ?? {},
        log: (line) => lines.push(line),
        timeoutMs: options.timeoutMs,
        target: LINUX,
        cache: options.cache ?? new Map(),
        now: options.now,
      });
      return { result, lines };
    },
    calls() {
      try {
        return readFileSync(path.join(dir, "calls.jsonl"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]);
      } catch {
        return [];
      }
    },
  };
}

function manifest(): string {
  return `${JSON.stringify({
    name: "@backend",
    dependencies: Object.fromEntries([
      ["@archestra/shared", "workspace:*"],
      ...CRATES.map((crate) => [`@archestra/${crate}`, "workspace:*"]),
      ["fastify", "5.0.0"],
    ]),
  })}\n`;
}

/**
 * The installer stand-in: appends its arguments to calls.jsonl, then installs
 * and stamps every crate it was asked for, exits 1 without installing, or
 * sleeps past any timeout.
 */
function stub(
  script: string,
  dir: string,
  behaviour: "installs" | "fails" | "stalls",
  key: string,
): void {
  writeFileSync(
    script,
    [
      'import { appendFileSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      `const dir = ${JSON.stringify(dir)};`,
      `const key = ${JSON.stringify(key)};`,
      "const names = process.argv.slice(2);",
      'appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(names) + "\\n");',
      `const behaviour = ${JSON.stringify(behaviour)};`,
      'if (behaviour === "stalls") await new Promise((resolve) => setTimeout(resolve, 10_000));',
      'if (behaviour === "fails") process.exit(1);',
      "for (const name of names) {",
      '  writeFileSync(path.join(dir, "platform/archestra-rs", name, "index.linux-x64-gnu.node"), "");',
      '  writeFileSync(path.join(dir, "platform/archestra-rs", name, ".napi-prebuilt"), key + " 0\\n");',
      "}",
      "",
    ].join("\n"),
  );
}
