import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

test("reinitializing a retained workspace refreshes Git auth without duplicating URL rewrites", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-init-"));
  try {
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const gh = path.join(bin, "gh");
    await writeFile(
      gh,
      `#!/bin/sh
if [ "$1 $2" = "auth login" ]; then cat > "$HOME/current-token"; fi
`,
    );
    await chmod(gh, 0o755);
    const env = {
      ...process.env,
      HOME: root,
      GIT_CONFIG_GLOBAL: path.join(root, ".gitconfig"),
      PATH: `${bin}:${process.env.PATH}`,
      OPENAI_BASE_URL: "",
      OPENAI_API_KEY: "",
      GH_TOKEN: "",
    };
    for (const token of [
      "first-synthetic-token",
      "refreshed-synthetic-token",
      "third-synthetic-token",
    ]) {
      await exec(
        "sh",
        [
          path.resolve(
            import.meta.dirname,
            "../../../../agent_images/bin/archestra-agent-init",
          ),
        ],
        {
          env: { ...env, GITHUB_TOKEN: token },
        },
      );
      expect(
        (await readFile(path.join(root, "current-token"), "utf8")).trim(),
      ).toBe(token);
      const rewrites = await exec(
        "git",
        [
          "config",
          "--global",
          "--get-all",
          "url.https://github.com/.insteadOf",
        ],
        { env },
      );
      expect(rewrites.stdout.trim().split("\n")).toEqual([
        "git@github.com:",
        "ssh://git@github.com/",
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  "login",
  "setup-git",
])("reports safe GitHub %s startup failures", async (command) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-init-failure-"));
  try {
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const gh = path.join(bin, "gh");
    await writeFile(
      gh,
      `#!/bin/sh
if [ "$1 $2" = "auth login" ]; then cat >/dev/null; fi
if [ "$2" = "$TEST_FAIL_COMMAND" ]; then
  echo 'synthetic-secret-do-not-forward' >&2
  exit 1
fi
`,
    );
    await chmod(gh, 0o755);
    const result = await exec(
      "sh",
      [
        path.resolve(
          import.meta.dirname,
          "../../../../agent_images/bin/archestra-agent-init",
        ),
      ],
      {
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: root,
          GITHUB_TOKEN: "synthetic-secret-do-not-forward",
          TEST_FAIL_COMMAND: command,
          ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX: path.join(root, "turn"),
        },
      },
    ).catch((error) => error);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain("GitHub authentication setup failed");
    expect(result.stderr).not.toContain("synthetic-secret");
    const failure = JSON.parse(
      await readFile(path.join(root, "turn.failure"), "utf8"),
    );
    expect(failure).toMatchObject({ version: 1, code: "github_configuration" });
    expect(failure.message).toContain("GitHub credential");
    expect(JSON.stringify(failure)).not.toContain("synthetic-secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["401", "provider_credential_rejected", "credential was rejected"],
  ["403", "provider_permission_denied", "does not have access to this model"],
  ["404", "model_unavailable", "endpoint was not found"],
  ["429", "provider_rate_limited", "rate limit was reached"],
] as const)("stops model discovery immediately on HTTP %s", async (status, code, message) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-init-http-"));
  try {
    const bin = path.join(root, "bin");
    const runtime = path.join(root, "runtime");
    await mkdir(bin);
    await mkdir(runtime);
    await writeFile(
      path.join(bin, "curl"),
      [
        "#!/bin/sh",
        "printf '%s' \"$TEST_HTTP_STATUS\"",
        "printf '%s\\n' attempt >> \"$ARCHESTRA_AGENT_RUNTIME_DIR/curl-attempts\"",
        "exit 22",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(bin, "curl"), 0o755);
    await chmod(path.join(bin, "sleep"), 0o755);
    const prefix = path.join(root, "turn");
    const result = await exec(
      "sh",
      [
        path.resolve(
          import.meta.dirname,
          "../../../../agent_images/bin/archestra-agent-init",
        ),
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          HOME: root,
          OPENAI_BASE_URL: "http://proxy.invalid/v1",
          OPENAI_API_KEY: "synthetic-secret-do-not-forward",
          TEST_HTTP_STATUS: status,
          ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
          ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX: prefix,
        },
      },
    ).catch((error) => error);

    expect(result.code).toBe(69);
    expect(await readFile(path.join(runtime, "curl-attempts"), "utf8")).toBe(
      "attempt\n",
    );
    const failure = JSON.parse(await readFile(`${prefix}.failure`, "utf8"));
    expect(failure).toMatchObject({ version: 1, code });
    expect(failure.message).toContain(message);
    expect(JSON.stringify(failure)).not.toContain("synthetic-secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounds transient model discovery failures and reports proxy_unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-init-http-5xx-"));
  try {
    const bin = path.join(root, "bin");
    const runtime = path.join(root, "runtime");
    await mkdir(bin, { recursive: true });
    await mkdir(runtime, { recursive: true });
    await writeFile(
      path.join(bin, "curl"),
      [
        "#!/bin/sh",
        "printf '%s' \"$TEST_HTTP_STATUS\"",
        "printf '%s\\n' attempt >> \"$ARCHESTRA_AGENT_RUNTIME_DIR/curl-attempts\"",
        "exit 22",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(bin, "curl"), 0o755);
    await chmod(path.join(bin, "sleep"), 0o755);
    const prefix = path.join(root, "turn");
    const result = await exec(
      "sh",
      [
        path.resolve(
          import.meta.dirname,
          "../../../../agent_images/bin/archestra-agent-init",
        ),
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          HOME: root,
          OPENAI_BASE_URL: "http://proxy.invalid/v1",
          OPENAI_API_KEY: "synthetic-secret-do-not-forward",
          TEST_HTTP_STATUS: "503",
          ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
          ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX: prefix,
        },
      },
    ).catch((error) => error);

    expect(result.code).toBe(69);
    expect(
      (await readFile(path.join(runtime, "curl-attempts"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(30);
    const failure = JSON.parse(await readFile(`${prefix}.failure`, "utf8"));
    expect(failure).toMatchObject({ version: 1, code: "proxy_unavailable" });
    expect(JSON.stringify(failure)).not.toContain("synthetic-secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
