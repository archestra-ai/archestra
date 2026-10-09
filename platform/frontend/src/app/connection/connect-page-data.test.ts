// Runs under jsdom, not the node project: the installer command is built
// inside the useConnectPageData hook, which reads window.location.origin and
// needs its data hooks mocked (the node project rejects vi.mock). Node's
// child_process and http still work here.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { INSTALLER_CLIENT_IDS } from "@archestra/shared/connection-setup";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CONNECT_CLIENTS } from "./clients";
import { ALL_INCLUDED, type ConnectChoices } from "./connect-choices";
import { useConnectPageData } from "./connect-page-data";

// The command only depends on the page origin, the app and the choices; the
// data hooks just need to render with nothing loaded.
vi.mock("@/lib/agent.query", () => ({
  useDefaultMcpGateway: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: false }),
}));
vi.mock("@/lib/mcp/gateway-tool-preview.query", () => ({
  useGatewayToolPreview: () => ({ data: undefined }),
}));
vi.mock("@/lib/config/config.query", () => ({
  useConfig: () => ({ data: undefined }),
}));
vi.mock("@/lib/guardrails-deployment.query", () => ({
  useGuardrailsDeployment: () => ({ data: undefined }),
}));
vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));
vi.mock("@/lib/llm-proxy.query", () => ({
  useLlmProxy: () => ({ data: undefined }),
}));
vi.mock("@/lib/organization.query", () => {
  const refetch = () => Promise.resolve();
  return {
    useOrganization: () => ({
      data: {},
      isPending: false,
      isFetching: false,
      refetch,
    }),
  };
});
vi.mock("@/lib/plugins/plugin.query", () => ({
  isDeliverablePlugin: () => false,
  usePlugins: () => ({ data: undefined }),
}));
vi.mock("@/lib/skills/skill.query", () => ({
  useAllSkills: () => ({ data: undefined }),
}));
vi.mock("./use-gateway-servers", () => ({
  useGatewayServers: () => ({
    gateway: undefined,
    profileQuery: { isPending: false },
    accessAll: false,
    servers: [],
  }),
}));

const execFileAsync = promisify(execFile);
const INSTALLER_PATH = "/api/client-connections/installer";

describe("Connect page installer command", () => {
  it.each(
    INSTALLER_CLIENT_IDS,
  )("runs the %s command in a POSIX shell with the page's flags", async (clientId) => {
    const { origin, argv, leftovers } = await runPosixCommand(
      clientId,
      ALL_INCLUDED,
    );
    expect(argv).toEqual(["--url", origin, "--client", clientId]);
    expect(leftovers).toEqual([]);
  });

  it("passes the parts left out as --exclude, in setup order", async () => {
    const { origin, argv, leftovers } = await runPosixCommand("codex", {
      ...ALL_INCLUDED,
      skills: false,
      plugins: false,
    });
    expect(argv).toEqual([
      "--url",
      origin,
      "--client",
      "codex",
      "--exclude",
      "skills,plugins",
    ]);
    expect(leftovers).toEqual([]);
  });

  it("builds the PowerShell twin with a backtick continuation", () => {
    const origin = "http://127.0.0.1:9000";
    expect(
      pageInstallerCommand(
        origin,
        "codex",
        { ...ALL_INCLUDED, tools: false },
        true,
      ),
    ).toBe(
      `irm ${origin}${INSTALLER_PATH} \`\n` +
        `  | node - --url ${origin} --client codex --exclude tools`,
    );
  });
});

/** The command exactly as the Connect page builds it on `origin`. */
function pageInstallerCommand(
  origin: string,
  clientId: string,
  choices: ConnectChoices,
  windows: boolean,
): string {
  const client = CONNECT_CLIENTS.find((c) => c.id === clientId);
  if (!client) throw new Error(`Missing client: ${clientId}`);
  vi.stubGlobal("location", new URL(origin));
  try {
    const { result, unmount } = renderHook(() => useConnectPageData());
    try {
      return result.current.installerCommand(client, choices, windows);
    } finally {
      unmount();
    }
  } finally {
    vi.unstubAllGlobals();
  }
}

/**
 * Runs the page's macOS/Linux command with `bash -c` against a local server
 * whose installer records the arguments it got. The command runs in an empty
 * directory that is also its TMPDIR, so anything it writes shows up there.
 */
async function runPosixCommand(clientId: string, choices: ConnectChoices) {
  const root = await mkdtemp(join(tmpdir(), "connect-installer-"));
  const workdir = join(root, "workdir");
  const argvFile = join(root, "argv.json");
  const server = createServer((request, response) => {
    if (request.url !== INSTALLER_PATH) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/javascript" });
    response.end(
      `require("node:fs").writeFileSync(${JSON.stringify(argvFile)},JSON.stringify(process.argv.slice(2)))`,
    );
  });
  try {
    await mkdir(workdir);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected installer test server port");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const command = pageInstallerCommand(origin, clientId, choices, false);
    await execFileAsync("bash", ["-c", command], {
      cwd: workdir,
      env: { ...process.env, TMPDIR: workdir },
      timeout: 10_000,
    });
    return {
      origin,
      argv: JSON.parse(await readFile(argvFile, "utf8")) as string[],
      leftovers: await readdir(workdir),
    };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
}
