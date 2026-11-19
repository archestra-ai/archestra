import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { guardrailsPolicyQuery } from "@/lib/guardrails-policy.query";
import {
  batteryPolicySourceQuery,
  effectivePolicyQuery,
} from "@/lib/openappa-batteries.query";
import type { PolicyFile } from "./policy-files";
import { usePolicyDownload } from "./use-policy-download";
import type { PolicyWorkspace } from "./use-policy-workspace";

describe("usePolicyDownload", () => {
  it("zips every policy file at its path, with the effective policy beside them", async () => {
    const client = cachedClient();
    client.setQueryData(guardrailsPolicyQuery.queryKey, {
      content: "root",
    } as never);
    client.setQueryData(batteryPolicySourceQuery("github").queryKey, {
      entry: "github",
      name: "github",
      kind: "battery",
      content: "bundled battery",
    });
    client.setQueryData(
      batteryPolicySourceQuery("batteries/team/appa.toml").queryKey,
      {
        entry: "batteries/team/appa.toml",
        name: "team",
        kind: "battery",
        content: "uploaded battery",
      },
    );
    client.setQueryData(
      batteryPolicySourceQuery("rules/internal.toml").queryKey,
      {
        entry: "rules/internal.toml",
        name: "rules/internal.toml",
        kind: "repository",
        content: "repository file",
      },
    );
    client.setQueryData(effectivePolicyQuery.queryKey, {
      content: "composed",
    } as never);

    const download = renderDownload(client, {
      files: [
        file({ kind: "root", path: "appa.toml", entry: null }),
        file({ kind: "battery", entry: "github" }),
        file({ kind: "battery", entry: "batteries/team/appa.toml" }),
        // An unavailable battery has no source to read.
        file({ kind: "battery", entry: "slack", disabled: true }),
        file({ kind: "repository", entry: "rules/internal.toml" }),
        file({ kind: "validation", entry: "traces/deploy.json" }),
      ],
      validations: {
        files: [{ path: "traces/deploy.json", content: "trace" }],
      },
    });

    expect(download?.name).toBe("openappa-policy");
    expect(await download?.files()).toEqual([
      { path: "appa.toml", content: "root" },
      { path: "batteries/github.toml", content: "bundled battery" },
      { path: "batteries/team/appa.toml", content: "uploaded battery" },
      { path: "rules/internal.toml", content: "repository file" },
      { path: "traces/deploy.json", content: "trace" },
      { path: "effective-policy.toml", content: "composed" },
    ]);
  });

  it("gives a reader of MCP servers' rules only their rules files", async () => {
    const client = cachedClient();
    client.setQueryData(
      batteryPolicySourceQuery("mcp/github.toml", { serverRules: true })
        .queryKey,
      {
        entry: "mcp/github.toml",
        name: "mcp/github.toml",
        kind: "repository",
        content: "server rules",
      },
    );

    const download = renderDownload(client, {
      scoped: true,
      files: [file({ kind: "repository", entry: "mcp/github.toml" })],
      validations: null,
    });

    expect(download?.name).toBe("mcp-server-rules");
    expect(await download?.files()).toEqual([
      { path: "mcp/github.toml", content: "server rules" },
    ]);
  });

  it("offers nothing while the reader's access is unknown", () => {
    const download = renderDownload(cachedClient(), {
      isPending: true,
      files: [],
      validations: null,
    });
    expect(download).toBeNull();
  });
});

// Cached answers never go stale, so the hook reads them instead of fetching.
function cachedClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
  });
}

function renderDownload(
  client: QueryClient,
  workspace: {
    files: PolicyFile[];
    validations: { files: { path: string; content: string }[] } | null;
    scoped?: boolean;
    isPending?: boolean;
  },
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () =>
      usePolicyDownload({
        scoped: false,
        isPending: false,
        ...workspace,
      } as unknown as PolicyWorkspace),
    { wrapper },
  );
  return result.current;
}

function file(
  overrides: Pick<PolicyFile, "kind" | "entry"> & Partial<PolicyFile>,
): PolicyFile {
  const path = overrides.path ?? overrides.entry ?? "";
  return {
    key: path,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    label: path,
    disabled: false,
    ...overrides,
  };
}
