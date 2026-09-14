import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { DESKTOP_CONNECTION_INSTALLER } from "./connection-desktop-installer";

const require = createRequire(import.meta.url);
const token = "sk-ant-oat01-test-subscription";

test.each([
  {
    targetOs: "darwin",
    quotaFailure: false,
    insecureMcp: false,
    invalidMarketplace: false,
  },
  {
    targetOs: "darwin",
    quotaFailure: true,
    insecureMcp: false,
    invalidMarketplace: false,
  },
  {
    targetOs: "win32",
    quotaFailure: false,
    insecureMcp: false,
    invalidMarketplace: false,
  },
  {
    targetOs: "darwin",
    quotaFailure: false,
    insecureMcp: true,
    invalidMarketplace: false,
  },
  {
    targetOs: "darwin",
    quotaFailure: false,
    insecureMcp: false,
    invalidMarketplace: true,
  },
])("Desktop $targetOs browser setup without developer tools (quota failure=$quotaFailure)", async ({
  targetOs,
  quotaFailure,
  insecureMcp,
  invalidMarketplace,
}) => {
  const home = await mkdtemp(join(tmpdir(), "desktop-browser-setup-"));
  const opened: string[] = [];
  const native: string[] = [];
  const module = { exports: null };
  let verifier: string | undefined;
  let challenge: string | null = null;
  const network = async (url: string, options: RequestInit) => {
    if (url.includes("/api/connection-setups/script/")) {
      expect(options.headers).toEqual({
        Accept: "application/vnd.archestra.desktop-setup+json",
      });
      return Response.json({
        clientId: "claude-desktop",
        appName: "Test Platform",
        proxy: {
          url: "https://proxy.example/v1/anthropic",
          authMode: "provider-key",
          passthroughVirtualKey: "test-user-key",
        },
        mcp: {
          serverName: "Test gateway",
          url: insecureMcp
            ? "http://localhost:9000/v1/mcp/test"
            : "https://proxy.example/v1/mcp/test",
        },
        skills: {
          cloneUrl: "https://proxy.example/marketplace.git",
          marketplaceName: "shared",
        },
      });
    }
    if (url.endsWith("/info/refs?service=git-upload-pack")) {
      if (invalidMarketplace) return new Response("not a git repository");
      return new Response(
        `001e# service=git-upload-pack\n0000003f${"a".repeat(40)} HEAD\0symref=HEAD:refs/heads/main\n0000`,
      );
    }
    const body = JSON.parse(options.body as string);
    if (url.endsWith("/v1/oauth/token")) {
      verifier = body.code_verifier;
      expect(
        createHash("sha256")
          .update(verifier ?? "")
          .digest("base64url"),
      ).toBe(challenge);
      expect(body.grant_type).toBe("authorization_code");
      expect(body.expires_in).toBe(31536000);
      expect(body.code).toBe("test-code");
      return Response.json({ access_token: token });
    }
    expect(url).toBe("https://proxy.example/v1/anthropic/v1/messages");
    expect(options.headers).toMatchObject({
      Authorization: `Bearer ${token}`,
      "X-Archestra-Virtual-Key": "test-user-key",
      "anthropic-beta": "oauth-2025-04-20",
    });
    expect(body.messages).toHaveLength(1);
    return quotaFailure
      ? new Response("quota", { status: 429 })
      : Response.json({
          type: "message",
          content: [{ type: "text", text: "OK" }],
        });
  };
  runInNewContext(DESKTOP_CONNECTION_INSTALLER, {
    module,
    require: (name: string) => {
      if (name === "node:os")
        return { homedir: () => home, tmpdir: () => home };
      if (name === "node:child_process")
        return {
          spawn: (file: string) => {
            native.push(file);
            const child = Object.assign(new EventEmitter(), { unref() {} });
            queueMicrotask(() => child.emit("spawn"));
            return child;
          },
          execFile: (
            file: string,
            args: string[],
            optionsOrCallback:
              | object
              | ((error: Error | null, result?: object) => void),
            optionalCallback?: (error: Error | null, result?: object) => void,
          ) => {
            const callback =
              optionalCallback ??
              (optionsOrCallback as (
                error: Error | null,
                result?: object,
              ) => void);
            native.push(file);
            if (file === "/usr/bin/open" && args[0] !== "-a")
              opened.push(args[0]);
            if (file === "rundll32.exe") opened.push(args[1]);
            if (file === "/usr/bin/pgrep")
              callback(Object.assign(new Error("not running"), { code: 1 }));
            else callback(null, { stdout: "S-1-test-user" });
          },
        };
      return require(name);
    },
    process: { platform: targetOs, env: { PATH: "", LOCALAPPDATA: home } },
    Buffer,
    URL,
    URLSearchParams,
    fetch: network,
    AbortSignal,
    setTimeout,
    clearTimeout,
  });
  const Installer = module.exports as unknown as new (
    ticket: object,
  ) => { start(): Promise<void>; close(): void };
  const installer = new Installer({
    origin: "https://proxy.example",
    rawToken: "test-ticket",
  });
  try {
    await installer.start();
    const page = opened[0];
    const origin = new URL(page).origin;
    const status = async () => (await fetch(`${page}/status`)).json();
    if (insecureMcp) {
      expect(await status()).toMatchObject({
        phase: "error",
        message: expect.stringContaining("requires HTTPS for MCP sign-in"),
      });
      expect(await readdir(home)).toEqual([]);
      expect(opened).toHaveLength(1);
      return;
    }
    expect((await status()).phase).toBe("signin");
    expect(
      (await fetch(page)).headers.get("content-security-policy"),
    ).toContain("frame-ancestors 'none'");
    expect(
      (
        await fetch(`${page}/continue`, {
          method: "POST",
          headers: { Origin: "https://untrusted.example" },
        })
      ).status,
    ).toBe(404);
    expect(opened).toHaveLength(1);
    await fetch(`${page}/continue`, {
      method: "POST",
      headers: { Origin: origin },
    });
    await expect.poll(() => opened.length).toBe(2);
    const oauth = new URL(opened[1]);
    expect(oauth.origin).toBe("https://claude.ai");
    expect(oauth.searchParams.get("scope")).toBe("user:inference");
    challenge = oauth.searchParams.get("code_challenge");
    const callback = new URL(oauth.searchParams.get("redirect_uri") ?? "");
    callback.search = new URLSearchParams({
      state: "wrong-state",
      code: "test-code",
    }).toString();
    expect((await fetch(callback)).status).toBe(400);
    expect(verifier).toBeUndefined();
    callback.searchParams.set("state", oauth.searchParams.get("state") ?? "");
    expect((await fetch(callback, { redirect: "manual" })).status).toBe(303);
    await expect
      .poll(async () => (await status()).phase)
      .toBe(quotaFailure || invalidMarketplace ? "error" : "ready");
    expect(JSON.stringify(await status())).not.toContain(token);
    expect((await fetch(callback)).status).toBe(400);
    const library = join(
      home,
      targetOs === "win32"
        ? "Claude-3p/configLibrary"
        : "Library/Application Support/Claude-3p/configLibrary",
    );
    if (quotaFailure || invalidMarketplace) {
      expect((await status()).message).toContain(
        quotaFailure ? "429" : "valid Git revision",
      );
      expect(native).not.toContain("/usr/bin/osascript");
      expect(await readdir(home)).toEqual([]);
    } else {
      await fetch(`${page}/continue`, {
        method: "POST",
        headers: { Origin: origin },
      });
      await expect.poll(async () => (await status()).phase).toBe("restarting");
      const metadata = JSON.parse(
        await readFile(join(library, "_meta.json"), "utf8"),
      );
      const profileFile = join(library, `${metadata.appliedId}.json`);
      const profile = JSON.parse(await readFile(profileFile, "utf8"));
      expect(profile.inferenceGatewayApiKey).toBe(token);
      expect(profile.inferenceGatewayBaseUrl).toBe(
        "https://proxy.example/v1/anthropic",
      );
      expect(profile.managedMcpServers[0].oauth).toEqual({ mode: "dcr" });
      expect(profile.allowedPluginMarketplaces[0]).toMatchObject({
        expectedName: "shared",
        ref: "a".repeat(40),
        installationPreference: "auto_install",
      });
      expect((await stat(profileFile)).mode & 0o777).toBe(0o600);
      expect(native).toContain(
        targetOs === "win32" ? "powershell.exe" : "/bin/sh",
      );
      expect(
        native.every((command) =>
          targetOs === "win32"
            ? ["powershell.exe", "icacls.exe", "rundll32.exe"].includes(command)
            : command.startsWith("/usr/bin/") || command === "/bin/sh",
        ),
      ).toBe(true);
      // A rerun reuses a verified subscription without a second browser sign-in.
      const repeated = new Installer({
        origin: "https://proxy.example",
        rawToken: "second-ticket",
      });
      try {
        await repeated.start();
        const secondPage = opened.at(-1);
        expect((await (await fetch(`${secondPage}/status`)).json()).phase).toBe(
          "ready",
        );
      } finally {
        repeated.close();
      }
    }
  } finally {
    installer.close();
    await rm(home, { recursive: true, force: true });
  }
});
