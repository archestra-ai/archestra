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
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_CLIENTS } from "./clients";
import {
  ALL_INCLUDED,
  type ConnectChoices,
  type ConnectPicks,
} from "./connect-choices";
import {
  gatewayServerName,
  useConnectPageData,
  welcomePrompt,
} from "./connect-page-data";

// The command only depends on the page origin, the app, the choices and
// picks; the data hooks render with nothing loaded unless a test sets a
// gateway or plugins.
const mocks = vi.hoisted(() => ({
  gateway: undefined as
    | { id: string; slug: string; name: string; agentType: "mcp_gateway" }
    | undefined,
  plugins: undefined as
    | {
        id: string;
        pluginSlug: string;
        displayName: string;
        description: null;
        supportedPlatforms: string[];
      }[]
    | undefined,
}));
vi.mock("@/lib/agent.query", () => ({
  useDefaultMcpGateway: () => ({
    data: mocks.gateway ? { id: "gw-default" } : undefined,
    isLoading: false,
  }),
}));
vi.mock("@/lib/agent-options.query", () => ({
  useAgentOptionsPage: () => ({ data: undefined, isPending: false }),
  useAgentOptionsByIds: () => ({ data: [], isPending: false }),
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
  isDeliverablePlugin: () => true,
  usePlugins: () => ({ data: mocks.plugins }),
}));
vi.mock("@/lib/skills/skill.query", () => ({
  useSkillsPaginated: () => ({ data: undefined }),
}));
vi.mock("./use-gateway-servers", () => ({
  useGatewayServers: () => ({
    gateway: mocks.gateway,
    profileQuery: { isPending: false },
    accessAll: false,
    servers: [],
  }),
}));

const execFileAsync = promisify(execFile);
const INSTALLER_PATH = "/api/client-connections/installer";

describe("Connect page installer command", () => {
  afterEach(() => {
    mocks.gateway = undefined;
    mocks.plugins = undefined;
  });

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

  it("names a picked gateway and the plugins kept, by slug", () => {
    const origin = "http://127.0.0.1:9000";
    mocks.gateway = {
      id: "gw-coding",
      slug: "coding-gateway",
      name: "Coding",
      agentType: "mcp_gateway",
    };
    mocks.plugins = ["openappa", "pm", "style"].map((slug) => ({
      id: `id-${slug}`,
      pluginSlug: slug,
      displayName: slug,
      description: null,
      supportedPlatforms: ["posix", "windows"],
    }));
    const picks = (pluginIds: string[] | null): ConnectPicks => ({
      gatewayId: "gw-coding",
      pluginIds,
    });
    const command = (p: ConnectPicks, choices = ALL_INCLUDED) =>
      pageInstallerCommand(origin, "claude-code", choices, false, p).split(
        "| node - ",
      )[1];
    expect(command(picks(["id-openappa", "id-pm"]))).toBe(
      `--url ${origin} --client claude-code --gateway coding-gateway --plugins openappa,pm`,
    );
    // Every plugin kept is the default: no flag.
    expect(command(picks(null))).toBe(
      `--url ${origin} --client claude-code --gateway coding-gateway`,
    );
    // None kept is plugins left out.
    expect(command(picks([]))).toBe(
      `--url ${origin} --client claude-code --exclude plugins --gateway coding-gateway`,
    );
    // Tools left out: no gateway to name.
    expect(command(picks(["id-pm"]), { ...ALL_INCLUDED, tools: false })).toBe(
      `--url ${origin} --client claude-code --exclude tools --plugins pm`,
    );
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

describe("Connect page plugins on the command's OS", () => {
  const claudeCode = CONNECT_CLIENTS.find((c) => c.id === "claude-code");
  if (!claudeCode) throw new Error("Missing client: claude-code");
  // Opened in a Windows browser.
  let platform: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    mocks.plugins = [
      plugin("everywhere", ["posix", "windows"]),
      plugin("posix-only", ["posix"]),
      plugin("windows-only", ["windows"]),
    ];
  });
  afterEach(() => {
    platform.mockRestore();
    mocks.plugins = undefined;
  });

  it("offers the plugins the other command installs once the user picks it", () => {
    const { result } = renderHook(() => useConnectPageData());
    const offered = () =>
      result.current.pluginsFor(claudeCode).map((p) => p.slug);
    expect(result.current.windows).toBe(true);
    expect(offered()).toEqual(["everywhere", "windows-only"]);

    // "Use the macOS / Linux command"
    act(() => result.current.setWindows(false));
    expect(offered()).toEqual(["everywhere", "posix-only"]);
    expect(
      result.current.keptPlugins(claudeCode, null).map((p) => p.slug),
    ).toEqual(["everywhere", "posix-only"]);
  });

  it("names only the kept plugins built for the command's OS", () => {
    const origin = "http://127.0.0.1:9000";
    // Both plugins on the Windows list kept.
    const picks: ConnectPicks = {
      gatewayId: null,
      pluginIds: ["id-everywhere", "id-windows-only"],
    };
    const flags = (windows: boolean) =>
      pageInstallerCommand(
        origin,
        "claude-code",
        ALL_INCLUDED,
        windows,
        picks,
      ).split("| node - ")[1];
    // Every Windows plugin kept: the default, no flag.
    expect(flags(true)).toBe(`--url ${origin} --client claude-code`);
    // The macOS / Linux command must not install the posix plugin never kept.
    expect(flags(false)).toBe(
      `--url ${origin} --client claude-code --plugins everywhere`,
    );
  });
});

function plugin(slug: string, supportedPlatforms: string[]) {
  return {
    id: `id-${slug}`,
    pluginSlug: slug,
    displayName: slug,
    description: null,
    supportedPlatforms,
  };
}

/** The command exactly as the Connect page builds it on `origin`. */
function pageInstallerCommand(
  origin: string,
  clientId: string,
  choices: ConnectChoices,
  windows: boolean,
  picks?: ConnectPicks,
): string {
  const client = CONNECT_CLIENTS.find((c) => c.id === clientId);
  if (!client) throw new Error(`Missing client: ${clientId}`);
  vi.stubGlobal("location", new URL(origin));
  try {
    const { result, unmount } = renderHook(() => useConnectPageData());
    try {
      return result.current.installerCommand(client, choices, windows, picks);
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

describe("Connect page welcome prompt", () => {
  const client = (id: string) => {
    const found = CONNECT_CLIENTS.find((c) => c.id === id);
    if (!found) throw new Error(`no client ${id}`);
    return found;
  };
  const gateway = (name: string, isPersonalGateway = false) => ({
    id: "gw-1",
    slug: "gw",
    name,
    agentType: "mcp_gateway" as const,
    isPersonalGateway,
  });
  const serverFor = (
    id: string,
    gw: ReturnType<typeof gateway> | null,
    tools = true,
  ) =>
    gatewayServerName({
      client: client(id),
      gateway: gw,
      appName: "Acme AI",
      tools,
    });

  it("names the gateway as installer setups register it", () => {
    expect(serverFor("claude-code", gateway("My Gateway", true))).toBe(
      "acme_ai",
    );
    expect(serverFor("claude-desktop", gateway("Team Gateway"))).toBe(
      "team_gateway",
    );
    expect(
      welcomePrompt({
        origin: "https://acme.test",
        appName: "Acme AI",
        serverName: "team_gateway",
      }),
    ).toBe(
      "Read https://acme.test/welcome.md?server=team_gateway and show me what I can do with Acme AI. Do not call, test, reconnect or sign in to my other MCP servers. Leave them out of your answer.",
    );
  });

  it("names no server when the page can't know it", () => {
    // Agents set up from a prompt or by hand pick their own name.
    expect(serverFor("amp", gateway("Team Gateway"))).toBeNull();
    expect(serverFor("generic", gateway("Team Gateway"))).toBeNull();
    // Tools left out, or no gateway: nothing was registered.
    expect(serverFor("claude-code", gateway("Team Gateway"), false)).toBeNull();
    expect(serverFor("claude-code", null)).toBeNull();
    // A name a prompt can't carry plainly.
    expect(serverFor("claude-code", gateway('R&D "prod"'))).toBeNull();
    expect(
      welcomePrompt({
        origin: "https://acme.test",
        appName: "Acme AI",
        serverName: null,
      }),
    ).toBe(
      "Read https://acme.test/welcome.md and show me what I can do with Acme AI.",
    );
  });
});
