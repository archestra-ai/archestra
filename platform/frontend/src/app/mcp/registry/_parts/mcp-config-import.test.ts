import {
  applyImportedServerToForm,
  canExportRegistryJson,
  canExportServersJson,
  type ImportedMcpServer,
  mcpJsonExportFileName,
  parseMcpConfigText,
  serializeFormValuesToMcpJson,
} from "./mcp-config-import";

function expectServers(result: ReturnType<typeof parseMcpConfigText>) {
  if (result.status !== "servers") {
    throw new Error(`Expected servers result, got ${result.status}`);
  }
  return result;
}

describe("parseMcpConfigText", () => {
  it("returns empty for whitespace input", () => {
    expect(parseMcpConfigText("  \n ")).toEqual({ status: "empty" });
  });

  it("reports invalid JSON with the parse error", () => {
    const result = parseMcpConfigText("{ not json");
    expect(result.status).toBe("invalid-json");
  });

  it("does not recognize arbitrary JSON objects", () => {
    expect(parseMcpConfigText('{"foo": 1}').status).toBe("unrecognized");
    expect(parseMcpConfigText('{"servers": {"a": {"foo": 1}}}').status).toBe(
      "unrecognized",
    );
  });

  it("parses a bare JSON array as arguments", () => {
    const result = parseMcpConfigText(
      '["-y", "@modelcontextprotocol/server-github"]',
    );
    expect(result).toEqual({
      status: "args-array",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
  });

  it("parses a Claude Desktop mcpServers wrapper with placeholder env values", () => {
    const result = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          mcpServers: {
            sonarqube: {
              command: "docker",
              args: [
                "run",
                "--init",
                "--pull=always",
                "-i",
                "--rm",
                "-e",
                "SONARQUBE_TOKEN",
                "-e",
                "SONARQUBE_ORG",
                "mcp/sonarqube",
              ],
              env: {
                SONARQUBE_TOKEN: "<token>",
                SONARQUBE_ORG: "<org>",
              },
            },
          },
        }),
      ),
    );

    expect(result.formatLabel).toBe("Claude Desktop / Cursor format");
    expect(result.servers).toHaveLength(1);
    const server = result.servers[0];
    expect(server.key).toBe("sonarqube");
    expect(server.values.serverType).toBe("local");
    // docker run is unwrapped into a direct image reference
    expect(server.values.localConfig?.dockerImage).toBe("mcp/sonarqube");
    expect(server.values.localConfig?.command).toBe("");

    // Placeholder values are never imported literally: they become
    // install-time prompts (this is what got PR #4311 rejected).
    const token = server.values.localConfig?.environment.find(
      (env) => env.key === "SONARQUBE_TOKEN",
    );
    expect(token).toMatchObject({
      type: "secret",
      promptOnInstallation: true,
      required: true,
    });
    expect(token?.value).toBeUndefined();
    const org = server.values.localConfig?.environment.find(
      (env) => env.key === "SONARQUBE_ORG",
    );
    expect(org).toMatchObject({
      type: "plain_text",
      promptOnInstallation: true,
    });
  });

  it("parses a VS Code servers wrapper with HTTP transport and inputs", () => {
    const result = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          servers: {
            github: {
              type: "http",
              url: "https://api.githubcopilot.com/mcp/",
              headers: {
                // biome-ignore lint/suspicious/noTemplateCurlyInString: literal VS Code input-reference syntax under test
                Authorization: "Bearer ${input:github_mcp_pat}",
                "X-Custom": "static-value",
              },
            },
          },
          inputs: [
            {
              type: "promptString",
              id: "github_mcp_pat",
              description: "GitHub Personal Access Token",
              password: true,
            },
          ],
        }),
      ),
    );

    expect(result.formatLabel).toBe("VS Code / Copilot format");
    const server = result.servers[0];
    expect(server.values.serverType).toBe("remote");
    expect(server.values.serverUrl).toBe("https://api.githubcopilot.com/mcp/");
    // An Authorization header maps to the modern Token-header method, with
    // the credential as a prompted row carrying the Bearer-prefix choice.
    expect(server.values.authMethod).toBe("auth_header");
    expect(server.values.additionalHeaders).toEqual([
      expect.objectContaining({
        headerName: "Authorization",
        promptOnInstallation: true,
        includeBearerPrefix: true,
        sensitive: true,
        description: "GitHub Personal Access Token",
      }),
      expect.objectContaining({
        headerName: "X-Custom",
        promptOnInstallation: false,
        value: "static-value",
      }),
    ]);
    // ${input:...} token produces no warning — nothing usable was dropped
    expect(server.warnings).toEqual([]);
  });

  it("warns when a literal Authorization token cannot be imported", () => {
    const result = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          servers: {
            api: {
              type: "http",
              url: "https://mcp.example.com/mcp",
              headers: { Authorization: "Bearer ghp_realtoken123" },
            },
          },
        }),
      ),
    );
    expect(result.servers[0].warnings).toEqual([
      expect.stringContaining("Authorization token is not imported"),
    ]);
  });

  it("parses a bare server object and a single-key wrapper", () => {
    const bare = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        }),
      ),
    );
    expect(bare.servers[0].values.localConfig?.command).toBe("npx");
    expect(bare.servers[0].values.localConfig?.arguments).toBe(
      "-y\n@modelcontextprotocol/server-filesystem\n/tmp",
    );

    const wrapped = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem"],
          },
        }),
      ),
    );
    expect(wrapped.servers[0].key).toBe("filesystem");
    expect(wrapped.servers[0].values.name).toBe("filesystem");
  });

  it("returns every server of a multi-server wrapper", () => {
    const result = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          mcpServers: {
            a: { command: "npx", args: ["-y", "server-a"] },
            b: { type: "http", url: "https://b.example.com/mcp" },
          },
        }),
      ),
    );
    expect(result.servers.map((server) => server.key)).toEqual(["a", "b"]);
    expect(result.servers[1].values.serverType).toBe("remote");
  });

  it("keeps stdio type entries local even when a url is present", () => {
    const result = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
              url: "https://ignored.example.com",
            },
          },
        }),
      ),
    );
    expect(result.servers[0].values.serverType).toBe("local");
  });

  it("parses the official registry server.json npm package", () => {
    const result = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          name: "io.github.example/everything",
          description: "Example server",
          version: "1.0.2",
          packages: [
            {
              registryType: "npm",
              identifier: "@example/everything",
              version: "1.0.2",
              environmentVariables: [
                {
                  name: "API_KEY",
                  description: "Your API key",
                  isRequired: true,
                  isSecret: true,
                },
                { name: "REGION", isRequired: false, value: "eu" },
              ],
            },
          ],
        }),
      ),
    );

    expect(result.formatLabel).toBe("MCP registry server.json");
    const server = result.servers[0];
    expect(server.values.name).toBe("everything");
    expect(server.values.localConfig?.command).toBe("npx");
    expect(server.values.localConfig?.arguments).toBe(
      "-y\n@example/everything@1.0.2",
    );
    expect(server.values.localConfig?.environment).toEqual([
      expect.objectContaining({
        key: "API_KEY",
        type: "secret",
        promptOnInstallation: true,
        required: true,
        description: "Your API key",
      }),
      expect.objectContaining({
        key: "REGION",
        type: "plain_text",
        value: "eu",
        promptOnInstallation: false,
      }),
    ]);
  });

  it("parses registry remotes with secret headers as install-time prompts", () => {
    const result = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          name: "io.github.example/remote",
          remotes: [
            {
              type: "streamable-http",
              url: "https://mcp.example.com/mcp",
              headers: [
                {
                  name: "X-Api-Key",
                  description: "API key",
                  isRequired: true,
                  isSecret: true,
                },
              ],
            },
          ],
        }),
      ),
    );
    const server = result.servers[0];
    expect(server.values.serverType).toBe("remote");
    expect(server.values.additionalHeaders).toEqual([
      expect.objectContaining({
        headerName: "X-Api-Key",
        promptOnInstallation: true,
        sensitive: true,
        description: "API key",
      }),
    ]);
  });

  it("delegates the Archestra catalog manifest to the existing transformer", () => {
    const result = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          name: "example__server",
          display_name: "Example Server",
          description: "From the catalog",
          server: {
            type: "remote",
            url: "https://mcp.example.com/mcp",
          },
        }),
      ),
    );
    expect(result.formatLabel).toBe("Archestra catalog manifest");
    expect(result.servers[0].values.name).toBe("Example Server");
    expect(result.servers[0].values.serverUrl).toBe(
      "https://mcp.example.com/mcp",
    );
  });

  it("warns about placeholder arguments", () => {
    const result = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          mcpServers: {
            fs: {
              command: "npx",
              args: ["-y", "server-filesystem", "/path/to/allowed/dir"],
              env: {},
            },
          },
        }),
      ),
    );
    // A real path is not a placeholder — no warning
    expect(result.servers[0].warnings).toEqual([]);

    const withPlaceholder = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          mcpServers: {
            fs: { command: "npx", args: ["-y", "server-x", "<project-root>"] },
          },
        }),
      ),
    );
    expect(withPlaceholder.servers[0].warnings).toEqual([
      expect.stringContaining("<project-root>"),
    ]);
  });
});

describe("serializeFormValuesToMcpJson round-trip", () => {
  it("serializes a local server without leaking secret values and round-trips", () => {
    const parsed = parseMcpConfigText(
      JSON.stringify({
        mcpServers: {
          myserver: { command: "npx", args: ["-y", "server-a"] },
        },
      }),
    );
    if (parsed.status !== "servers") throw new Error("unexpected");
    const values = {
      ...parsed.servers[0].values,
      name: "myserver",
      localConfig: {
        ...(parsed.servers[0].values.localConfig as NonNullable<
          ImportedMcpServer["values"]["localConfig"]
        >),
        dockerImage: "ghcr.io/acme/server:1",
        transportType: "streamable-http" as const,
        httpPort: "9090",
        httpPath: "/mcp",
        environment: [
          {
            key: "API_TOKEN",
            type: "secret" as const,
            value: "super-secret-value",
            promptOnInstallation: false,
            required: false,
            description: "",
          },
          {
            key: "REGION",
            type: "plain_text" as const,
            value: "eu",
            promptOnInstallation: false,
            required: false,
            description: "",
          },
        ],
      },
    };

    const json = serializeFormValuesToMcpJson(values);
    expect(json).not.toContain("super-secret-value");
    expect(json).toContain('"API_TOKEN": "<secret>"');
    expect(json).toContain('"REGION": "eu"');
    // Streamable HTTP is Archestra's gateway deployment transport — it never
    // enters the exported JSON (the dockerImage extension key still does).
    expect(json).not.toContain("transport");
    expect(json).not.toContain("httpPort");
    expect(json).not.toContain("httpPath");

    // Round-trip: parsing the serialized JSON yields the same server shape,
    // including the dockerImage extension key. The absent transport parses
    // as stdio — and the apply layer leaves the form's transport alone then.
    const reparsed = parseMcpConfigText(json);
    if (reparsed.status !== "servers") throw new Error("did not round-trip");
    const roundTripped = reparsed.servers[0].values.localConfig;
    expect(reparsed.servers[0].key).toBe("myserver");
    expect(roundTripped?.command).toBe("npx");
    expect(roundTripped?.dockerImage).toBe("ghcr.io/acme/server:1");
    expect(roundTripped?.transportType).toBe("stdio");
    expect(roundTripped?.httpPort).toBe("");
  });

  it("masks a stored secret value even after its row was flipped to plain text", () => {
    // Edit mode hydrates real stored secret values into the form. Flipping
    // the row's type to plain_text (unsaved) must not surface the stored
    // value in the serialized JSON or the clipboard — masking goes by value
    // identity against the hydrated secret bag, not only by row type.
    const parsed = parseMcpConfigText(
      JSON.stringify({
        mcpServers: { myserver: { command: "npx" } },
      }),
    );
    if (parsed.status !== "servers") throw new Error("unexpected");
    const values = {
      ...parsed.servers[0].values,
      name: "myserver",
      localConfig: {
        ...(parsed.servers[0].values.localConfig as NonNullable<
          ImportedMcpServer["values"]["localConfig"]
        >),
        environment: [
          {
            key: "API_TOKEN",
            type: "plain_text" as const,
            value: "hydrated-stored-secret",
            promptOnInstallation: false,
            required: false,
            description: "",
          },
          {
            key: "REGION",
            type: "plain_text" as const,
            value: "eu",
            promptOnInstallation: false,
            required: false,
            description: "",
          },
        ],
      },
    };

    const json = serializeFormValuesToMcpJson(values, {
      storedSecretValues: { API_TOKEN: "hydrated-stored-secret" },
    });
    expect(json).not.toContain("hydrated-stored-secret");
    expect(json).toContain('"API_TOKEN": "<secret>"');
    expect(json).toContain('"REGION": "eu"');
  });

  it("serializes a remote bearer server with a prompted Authorization header", () => {
    const parsed = parseMcpConfigText(
      JSON.stringify({
        servers: {
          api: {
            type: "http",
            url: "https://mcp.example.com/mcp",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal VS Code input-reference syntax under test
            headers: { Authorization: "Bearer ${input:token}" },
          },
        },
      }),
    );
    if (parsed.status !== "servers") throw new Error("unexpected");
    const json = serializeFormValuesToMcpJson({
      ...parsed.servers[0].values,
      name: "api",
    });
    expect(json).toContain('"url": "https://mcp.example.com/mcp"');
    expect(json).toContain('"Authorization": "Bearer <prompted-on-install>"');

    const reparsed = parseMcpConfigText(json);
    if (reparsed.status !== "servers") throw new Error("did not round-trip");
    expect(reparsed.servers[0].values.authMethod).toBe("auth_header");
    expect(reparsed.servers[0].values.additionalHeaders).toEqual([
      expect.objectContaining({
        headerName: "Authorization",
        promptOnInstallation: true,
        includeBearerPrefix: true,
      }),
    ]);
  });

  it("round-trips the Bearer prefix on prompted and static header rows", () => {
    // The Token-header auth method stores its credential as a prompted
    // Authorization row with includeBearerPrefix — the serialized JSON must
    // carry the prefix, and reparsing must put it back on the row, or a
    // JSON round-trip silently changes the wire header.
    const base = parseMcpConfigText(
      JSON.stringify({ type: "http", url: "https://mcp.example.com/mcp" }),
    );
    if (base.status !== "servers") throw new Error("unexpected");
    const json = serializeFormValuesToMcpJson({
      ...base.servers[0].values,
      name: "api",
      authMethod: "auth_header",
      additionalHeaders: [
        {
          headerName: "Authorization",
          promptOnInstallation: true,
          required: true,
          value: "",
          description: "",
          includeBearerPrefix: true,
          sensitive: true,
        },
        {
          headerName: "X-Api-Key",
          promptOnInstallation: false,
          required: false,
          value: "abc123",
          description: "",
          includeBearerPrefix: true,
          sensitive: false,
        },
      ],
    });
    expect(json).toContain('"Authorization": "Bearer <prompted-on-install>"');
    expect(json).toContain('"X-Api-Key": "Bearer abc123"');

    const reparsed = parseMcpConfigText(json);
    if (reparsed.status !== "servers") throw new Error("did not round-trip");
    const headers = reparsed.servers[0].values.additionalHeaders ?? [];
    expect(headers.find((h) => h.headerName === "Authorization")).toMatchObject(
      { promptOnInstallation: true, includeBearerPrefix: true },
    );
    expect(headers.find((h) => h.headerName === "X-Api-Key")).toMatchObject({
      promptOnInstallation: false,
      includeBearerPrefix: true,
      value: "abc123",
    });
  });
});

describe("applyImportedServerToForm", () => {
  function makeFormStub(initial: Record<string, unknown>) {
    const values: Record<string, unknown> = { ...initial };
    return {
      form: {
        getValues: (name: string) => values[name],
        setValue: (name: string, value: unknown) => {
          values[name] = value;
        },
      } as never,
      values,
    };
  }

  function makeImportedServer(
    overrides: Partial<ImportedMcpServer["values"]>,
  ): ImportedMcpServer {
    const parsed = parseMcpConfigText(
      JSON.stringify({ command: "npx", args: ["-y", "server-a"] }),
    );
    if (parsed.status !== "servers") throw new Error("unexpected");
    return {
      ...parsed.servers[0],
      values: { ...parsed.servers[0].values, ...overrides },
    };
  }

  it("refuses a server-type mismatch when the type is locked", () => {
    const { form } = makeFormStub({ serverType: "remote", name: "existing" });
    const result = applyImportedServerToForm({
      form,
      server: makeImportedServer({ serverType: "local" }),
      allowServerTypeChange: false,
      transportConfigured: true,
    });
    expect(result.applied).toBe(false);
  });

  it("hydrates config fields and fills name only when empty", () => {
    const { form, values } = makeFormStub({
      serverType: "remote",
      name: "My Existing Name",
      description: "",
    });
    const result = applyImportedServerToForm({
      form,
      server: makeImportedServer({ serverType: "local", name: "imported" }),
      allowServerTypeChange: true,
      transportConfigured: true,
    });
    expect(result.applied).toBe(true);
    expect(values.serverType).toBe("local");
    expect(values.name).toBe("My Existing Name");
    expect(values["localConfig.command"]).toBe("npx");
    expect(values["localConfig.arguments"]).toBe("-y\nserver-a");
  });

  it("keeps existing env entries when the import only has a placeholder", () => {
    const storedToken = {
      key: "API_TOKEN",
      type: "secret",
      value: "stored-secret",
      promptOnInstallation: false,
      required: false,
      description: "kept",
    };
    const { form, values } = makeFormStub({
      serverType: "local",
      name: "existing",
      "localConfig.environment": [storedToken],
    });
    const parsed = parseMcpConfigText(
      JSON.stringify({
        mcpServers: {
          existing: {
            command: "npx",
            args: ["-y", "server-a"],
            env: { API_TOKEN: "<prompted-on-install>", NEW_VAR: "plain" },
          },
        },
      }),
    );
    if (parsed.status !== "servers") throw new Error("unexpected");
    const result = applyImportedServerToForm({
      form,
      server: parsed.servers[0],
      allowServerTypeChange: false,
      transportConfigured: true,
    });
    expect(result.applied).toBe(true);
    const environment = values["localConfig.environment"] as Array<{
      key: string;
      value?: string;
      promptOnInstallation: boolean;
    }>;
    // The placeholder never downgrades the stored secret…
    expect(environment.find((env) => env.key === "API_TOKEN")).toEqual(
      storedToken,
    );
    // …while genuinely new entries come through.
    expect(environment.find((env) => env.key === "NEW_VAR")).toMatchObject({
      value: "plain",
      promptOnInstallation: false,
    });
  });

  it("keeps existing header rows when the import only has a placeholder", () => {
    const storedHeader = {
      fieldName: "header_authorization",
      headerName: "Authorization",
      promptOnInstallation: true,
      required: false,
      value: "",
      description: "kept",
      includeBearerPrefix: true,
      sensitive: true,
    };
    const { form, values } = makeFormStub({
      serverType: "remote",
      name: "existing",
      authMethod: "auth_header",
      additionalHeaders: [storedHeader],
    });
    const parsed = parseMcpConfigText(
      JSON.stringify({
        type: "http",
        url: "https://mcp.example.com/mcp",
        headers: {
          Authorization: "Bearer <prompted-on-install>",
          "X-New": "static",
        },
      }),
    );
    if (parsed.status !== "servers") throw new Error("unexpected");
    const result = applyImportedServerToForm({
      form,
      server: parsed.servers[0],
      allowServerTypeChange: false,
      transportConfigured: true,
    });
    expect(result.applied).toBe(true);
    const headers = values.additionalHeaders as Array<{
      headerName: string;
      fieldName?: string;
    }>;
    // The placeholder row keeps the stored row — field name, required flag,
    // and description survive the round-trip…
    expect(headers.find((h) => h.headerName === "Authorization")).toEqual(
      storedHeader,
    );
    // …while genuinely new headers come through.
    expect(headers.find((h) => h.headerName === "X-New")).toMatchObject({
      promptOnInstallation: false,
      value: "static",
    });
  });

  it("leaves non-header auth (e.g. OAuth) untouched when the import has none", () => {
    const { form, values } = makeFormStub({
      serverType: "remote",
      name: "existing",
      authMethod: "oauth",
    });
    const parsed = parseMcpConfigText(
      JSON.stringify({ type: "http", url: "https://mcp.example.com/mcp" }),
    );
    if (parsed.status !== "servers") throw new Error("unexpected");
    const result = applyImportedServerToForm({
      form,
      server: parsed.servers[0],
      allowServerTypeChange: false,
      transportConfigured: true,
    });
    expect(result.applied).toBe(true);
    expect(values.serverUrl).toBe("https://mcp.example.com/mcp");
    expect(values.authMethod).toBe("oauth");
  });

  it("leaves the deployment transport untouched on a stdio-shaped paste", () => {
    // Client config JSON cannot express Archestra's streamable-http gateway
    // transport, so a paste without one says nothing about it — a JSON
    // round-trip must never flip an existing deployment back to stdio.
    const { form, values } = makeFormStub({
      serverType: "local",
      name: "existing",
      "localConfig.transportType": "streamable-http",
      "localConfig.httpPort": "9090",
      "localConfig.httpPath": "/inner",
    });
    const parsed = parseMcpConfigText(
      JSON.stringify({ command: "npx", args: ["-y", "server-a"] }),
    );
    if (parsed.status !== "servers") throw new Error("unexpected");
    const result = applyImportedServerToForm({
      form,
      server: parsed.servers[0],
      allowServerTypeChange: false,
      transportConfigured: true,
    });
    expect(result.applied).toBe(true);
    expect(values["localConfig.transportType"]).toBe("streamable-http");
    expect(values["localConfig.httpPort"]).toBe("9090");
    expect(values["localConfig.httpPath"]).toBe("/inner");
  });

  it("a pristine create form takes the paste's transport, stdio included", () => {
    // With the transport not yet configured (fresh create form, whose
    // DEFAULT is streamable-http), the paste DEFINES the server — a plain
    // npx README snippet must deploy as the stdio server it is, not
    // silently inherit an HTTP transport it can never serve.
    const { form, values } = makeFormStub({
      serverType: "local",
      name: "",
      "localConfig.transportType": "streamable-http",
      "localConfig.httpPort": "",
    });
    const parsed = parseMcpConfigText(
      JSON.stringify({ command: "npx", args: ["-y", "server-a"] }),
    );
    if (parsed.status !== "servers") throw new Error("unexpected");
    const result = applyImportedServerToForm({
      form,
      server: parsed.servers[0],
      allowServerTypeChange: true,
      transportConfigured: false,
    });
    expect(result.applied).toBe(true);
    expect(values["localConfig.transportType"]).toBe("stdio");
  });

  it("a declared transport without a parseable port never clobbers configured values", () => {
    // Registry packages may carry template urls (http://localhost:{port}/…)
    // — the declaration flips the transport, but port/path are only written
    // when the paste actually carried them.
    const { form, values } = makeFormStub({
      serverType: "local",
      name: "existing",
      "localConfig.transportType": "streamable-http",
      "localConfig.httpPort": "9090",
      "localConfig.httpPath": "/inner",
    });
    const parsed = parseMcpConfigText(
      JSON.stringify({
        name: "acme/http-server",
        version: "1.0.0",
        packages: [
          {
            registryType: "npm",
            identifier: "http-server",
            transport: {
              type: "streamable-http",
              url: "http://localhost:{port}/mcp",
            },
          },
        ],
      }),
    );
    if (parsed.status !== "servers") throw new Error("unexpected");
    const result = applyImportedServerToForm({
      form,
      server: parsed.servers[0],
      allowServerTypeChange: false,
      transportConfigured: true,
    });
    expect(result.applied).toBe(true);
    expect(values["localConfig.transportType"]).toBe("streamable-http");
    expect(values["localConfig.httpPort"]).toBe("9090");
    expect(values["localConfig.httpPath"]).toBe("/inner");
  });

  it("applies the transport when the import explicitly declares streamable-http", () => {
    const { form, values } = makeFormStub({
      serverType: "local",
      name: "existing",
      "localConfig.transportType": "stdio",
    });
    const parsed = parseMcpConfigText(
      JSON.stringify({
        name: "acme/http-server",
        version: "1.0.0",
        packages: [
          {
            registryType: "npm",
            identifier: "http-server",
            transport: {
              type: "streamable-http",
              url: "http://localhost:9090/inner",
            },
          },
        ],
      }),
    );
    if (parsed.status !== "servers") throw new Error("unexpected");
    const result = applyImportedServerToForm({
      form,
      server: parsed.servers[0],
      allowServerTypeChange: false,
      transportConfigured: true,
    });
    expect(result.applied).toBe(true);
    expect(values["localConfig.transportType"]).toBe("streamable-http");
    expect(values["localConfig.httpPort"]).toBe("9090");
    expect(values["localConfig.httpPath"]).toBe("/inner");
  });
});

describe("mounted secret-file rows are outside the JSON contract", () => {
  function makeFormStub(initial: Record<string, unknown>) {
    const values: Record<string, unknown> = { ...initial };
    return {
      form: {
        getValues: (name: string) => values[name],
        setValue: (name: string, value: unknown) => {
          values[name] = value;
        },
      } as never,
      values,
    };
  }

  const mountedRow = {
    key: "TLS_CERT",
    type: "secret" as const,
    value: "stored-pem",
    promptOnInstallation: false,
    required: false,
    description: "mounted at /secrets/TLS_CERT",
    mounted: true,
  };

  it("serialize omits mounted rows from env", () => {
    const parsed = parseMcpConfigText(
      JSON.stringify({ command: "npx", env: { PLAIN: "yes" } }),
    );
    if (parsed.status !== "servers") throw new Error("unexpected");
    const values = parsed.servers[0].values;
    if (values.serverType !== "local" || !values.localConfig) {
      throw new Error("expected local values");
    }
    const json = serializeFormValuesToMcpJson({
      ...values,
      name: "files",
      localConfig: {
        ...values.localConfig,
        environment: [...values.localConfig.environment, mountedRow],
      },
    });
    expect(json).toContain('"PLAIN"');
    expect(json).not.toContain("TLS_CERT");
  });

  it("apply preserves mounted rows and lets them win key collisions", () => {
    const { form, values } = makeFormStub({
      serverType: "local",
      name: "existing",
      "localConfig.environment": [mountedRow],
    });
    // The pasted JSON has no TLS_CERT env entry at all, plus a colliding
    // plain entry would be a downgrade — the mounted row must survive both.
    const parsed = parseMcpConfigText(
      JSON.stringify({
        command: "npx",
        env: { PLAIN: "yes", TLS_CERT: "plain-text" },
      }),
    );
    if (parsed.status !== "servers") throw new Error("unexpected");
    const result = applyImportedServerToForm({
      form,
      server: parsed.servers[0],
      allowServerTypeChange: false,
      transportConfigured: true,
    });
    expect(result.applied).toBe(true);
    const env = values["localConfig.environment"] as Array<{
      key: string;
      mounted?: boolean;
      value?: string;
    }>;
    expect(env.map((row) => row.key).sort()).toEqual(["PLAIN", "TLS_CERT"]);
    const tls = env.find((row) => row.key === "TLS_CERT");
    expect(tls?.mounted).toBe(true);
    expect(tls?.value).toBe("stored-pem");
  });
});

describe("serializeFormValuesToMcpJson export formats", () => {
  // Every export format must be a shape parseMcpConfigText recognizes —
  // the format select and the import parser are one contract.

  function localValues() {
    const parsed = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          mcpServers: { files: { command: "npx", args: ["-y", "server-a"] } },
        }),
      ),
    );
    return { ...parsed.servers[0].values, name: "files" };
  }

  function remoteValues() {
    const parsed = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          mcpServers: {
            context: {
              type: "http",
              url: "https://api.example.com/mcp",
              headers: {
                Authorization: "Bearer <token>",
                "X-Region": "eu",
              },
            },
          },
        }),
      ),
    );
    return {
      ...parsed.servers[0].values,
      name: "context",
      description: "Docs lookup",
    };
  }

  it("servers format wraps in `servers`, marks stdio, and round-trips", () => {
    const json = serializeFormValuesToMcpJson(localValues(), {
      format: "servers",
    });
    const document = JSON.parse(json);
    expect(document.servers.files.type).toBe("stdio");

    const reparsed = expectServers(parseMcpConfigText(json));
    expect(reparsed.formatLabel).toBe("VS Code / Copilot format");
    expect(reparsed.servers[0].values.serverType).toBe("local");
    expect(reparsed.servers[0].values.localConfig?.command).toBe("npx");
    expect(reparsed.servers[0].values.localConfig?.arguments).toBe(
      "-y\nserver-a",
    );
  });

  it("registry format emits server.json and keeps secrets prompted", () => {
    const json = serializeFormValuesToMcpJson(remoteValues(), {
      format: "registry",
    });
    const document = JSON.parse(json);
    expect(document.name).toBe("context");
    expect(document.description).toBe("Docs lookup");
    expect(document.remotes[0].url).toBe("https://api.example.com/mcp");
    const authHeader = document.remotes[0].headers.find(
      (header: { name: string }) => header.name === "Authorization",
    );
    expect(authHeader.isSecret).toBe(true);
    expect(authHeader.value).toBeUndefined();

    const reparsed = expectServers(parseMcpConfigText(json));
    expect(reparsed.formatLabel).toBe("MCP registry server.json");
    expect(reparsed.servers[0].values.serverUrl).toBe(
      "https://api.example.com/mcp",
    );
    expect(reparsed.servers[0].values.name).toBe("context");
    const roundTrippedAuth = reparsed.servers[0].values.additionalHeaders?.find(
      (header) => header.headerName === "Authorization",
    );
    expect(roundTrippedAuth?.promptOnInstallation).toBe(true);
    const region = reparsed.servers[0].values.additionalHeaders?.find(
      (header) => header.headerName === "X-Region",
    );
    expect(region?.value).toBe("eu");
  });

  it("registry format emits an official npm package for an npx local and round-trips", () => {
    // The official server.json expresses package-shaped locals — see
    // registry.modelcontextprotocol.io. Secret env rows must come back as
    // install-time prompts; the package transport is always stdio because
    // Archestra's streamable-http exposure is gateway deployment config.
    const base = localValues();
    const localConfig = base.localConfig;
    if (!localConfig) throw new Error("expected local config");
    const values = {
      ...base,
      localConfig: {
        ...localConfig,
        transportType: "streamable-http" as const,
        environment: [
          {
            key: "API_TOKEN",
            type: "secret" as const,
            value: "stored-secret",
            promptOnInstallation: false,
            required: true,
            description: "token",
          },
        ],
      },
    };

    const json = serializeFormValuesToMcpJson(values, { format: "registry" });
    expect(json).not.toContain("stored-secret");
    const document = JSON.parse(json);
    expect(document.$schema).toContain(
      "static.modelcontextprotocol.io/schemas/",
    );
    expect(document.version).toBe("1.0.0");
    const pkg = document.packages[0];
    expect(pkg.registryType).toBe("npm");
    expect(pkg.identifier).toBe("server-a");
    expect(pkg.runtimeHint).toBe("npx");
    // Even though the FORM says streamable-http: that is how the Archestra
    // deployment is exposed on the MCP gateway, not part of the package.
    expect(pkg.transport).toEqual({ type: "stdio" });
    expect(pkg.environmentVariables[0]).toMatchObject({
      name: "API_TOKEN",
      isSecret: true,
      isRequired: true,
    });
    expect(pkg.environmentVariables[0].value).toBeUndefined();

    const reparsed = expectServers(parseMcpConfigText(json));
    expect(reparsed.formatLabel).toBe("MCP registry server.json");
    const roundTripped = reparsed.servers[0].values.localConfig;
    expect(roundTripped?.command).toBe("npx");
    expect(roundTripped?.arguments).toBe("-y\nserver-a");
    expect(roundTripped?.transportType).toBe("stdio");
    expect(
      roundTripped?.environment.find((env) => env.key === "API_TOKEN"),
    ).toMatchObject({ type: "secret", promptOnInstallation: true });
  });

  it("imports a third-party package that declares streamable-http transport", () => {
    // Import stays richer than export: a server.json whose package declares
    // streamable-http (with the schema-required url) maps onto Archestra's
    // deployment transport, port, and path.
    const parsed = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          name: "acme/http-server",
          version: "2.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "http-server",
              transport: {
                type: "streamable-http",
                url: "http://localhost:9090/inner",
              },
            },
          ],
        }),
      ),
    );
    const localConfig = parsed.servers[0].values.localConfig;
    expect(localConfig?.transportType).toBe("streamable-http");
    expect(localConfig?.httpPort).toBe("9090");
    expect(localConfig?.httpPath).toBe("/inner");
  });

  it("registry format for an arbitrary-command local falls back to the default wrapper", () => {
    const parsed = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          mcpServers: { files: { command: "node", args: ["server.js"] } },
        }),
      ),
    );
    const values = { ...parsed.servers[0].values, name: "files" };
    const json = serializeFormValuesToMcpJson(values, { format: "registry" });
    expect(JSON.parse(json).mcpServers).toBeDefined();
  });

  it("VS Code export is gated to shapes its schema accepts", () => {
    // additionalProperties: false in VS Code's mcp.json schema makes the
    // Archestra dockerImage extension key a hard validation error there. A
    // streamable-http command server exports fine — the transport is
    // deployment config that never enters the JSON.
    expect(canExportServersJson(remoteValues())).toBe(true);
    expect(canExportServersJson(localValues() as never)).toBe(true);
    const base = localValues();
    const localConfig = base.localConfig;
    if (!localConfig) throw new Error("expected local config");
    expect(
      canExportServersJson({
        ...base,
        localConfig: {
          ...localConfig,
          transportType: "streamable-http",
        },
      } as never),
    ).toBe(true);
    expect(
      canExportServersJson({
        ...base,
        localConfig: { ...localConfig, dockerImage: "ghcr.io/acme/server:1" },
      } as never),
    ).toBe(false);
  });

  it("servers format keeps a streamable-http local schema-clean", () => {
    // The exact shape the old code emitted extension keys for — now the
    // gate admits it, the output must be a plain stdio command entry.
    const base = localValues();
    const json = serializeFormValuesToMcpJson(
      {
        ...base,
        localConfig: {
          ...(base.localConfig as NonNullable<typeof base.localConfig>),
          transportType: "streamable-http" as const,
          httpPort: "9090",
        },
      },
      { format: "servers" },
    );
    const document = JSON.parse(json);
    expect(document.servers.files.type).toBe("stdio");
    expect(json).not.toContain("transport");
    expect(json).not.toContain("httpPort");
    expect(json).not.toContain("9090");
  });

  it("an image-only export is recognized by the parser (one contract)", () => {
    const base = localValues();
    const json = serializeFormValuesToMcpJson({
      ...base,
      name: "sonarqube",
      localConfig: {
        ...(base.localConfig as NonNullable<typeof base.localConfig>),
        command: "",
        arguments: "",
        dockerImage: "mcp/sonarqube",
      },
    });
    const reparsed = expectServers(parseMcpConfigText(json));
    expect(reparsed.servers[0].values.serverType).toBe("local");
    expect(reparsed.servers[0].values.localConfig?.dockerImage).toBe(
      "mcp/sonarqube",
    );
  });

  it("registry format expresses an image with entrypoint args as an oci package", () => {
    const base = localValues();
    const values = {
      ...base,
      localConfig: {
        ...(base.localConfig as NonNullable<typeof base.localConfig>),
        command: "",
        arguments: "-t\nstdio",
        dockerImage: "mcp/grafana",
      },
    };
    expect(canExportRegistryJson(values)).toBe(true);
    const document = JSON.parse(
      serializeFormValuesToMcpJson(values, { format: "registry" }),
    );
    expect(document.packages[0].registryType).toBe("oci");
    expect(document.packages[0].identifier).toBe("mcp/grafana");
    expect(document.packages[0].packageArguments).toEqual([
      { type: "positional", value: "-t" },
      { type: "positional", value: "stdio" },
    ]);
  });

  it("registry format always emits the schema-required description", () => {
    // ServerDetail requires a 1-100 char description; localValues has none,
    // so a starting value is written (like version).
    const document = JSON.parse(
      serializeFormValuesToMcpJson(localValues(), { format: "registry" }),
    );
    expect(typeof document.description).toBe("string");
    expect(document.description.length).toBeGreaterThan(0);
    expect(document.description.length).toBeLessThanOrEqual(100);
  });

  it("imports a docker run whose --port flag declares streamable-http", () => {
    // The container-side --port flag AFTER the image means the server
    // itself speaks HTTP — the one docker shape that flips the transport.
    const parsed = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          mcpServers: {
            grafana: {
              command: "docker",
              args: ["run", "--rm", "-i", "mcp/grafana", "--port", "8000"],
            },
          },
        }),
      ),
    );
    const localConfig = parsed.servers[0].values.localConfig;
    expect(localConfig?.dockerImage).toBe("mcp/grafana");
    expect(localConfig?.transportType).toBe("streamable-http");
    expect(localConfig?.httpPort).toBe("8000");
  });

  it("ignores the retired transport extension keys on import", () => {
    // Older exports carried transport/httpPort/httpPath extension keys;
    // they are deployment settings now and no longer parsed.
    const parsed = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          mcpServers: {
            legacy: {
              command: "npx",
              args: ["-y", "server-a"],
              transport: "streamable-http",
              httpPort: 9090,
              httpPath: "/inner",
            },
          },
        }),
      ),
    );
    const localConfig = parsed.servers[0].values.localConfig;
    expect(localConfig?.transportType).toBe("stdio");
    expect(localConfig?.httpPort).toBe("");
  });

  it("names downloads per format", () => {
    expect(mcpJsonExportFileName("mcpServers", "files")).toBe("files.mcp.json");
    expect(mcpJsonExportFileName("servers", "files")).toBe("mcp.json");
    expect(mcpJsonExportFileName("registry", "files")).toBe("server.json");
  });

  it("parse reports which export format a paste matches, when any", () => {
    // Drives the dialog's automatic format selection on paste.
    const mcpServers = expectServers(
      parseMcpConfigText(
        JSON.stringify({ mcpServers: { files: { command: "npx" } } }),
      ),
    );
    expect(mcpServers.format).toBe("mcpServers");
    const servers = expectServers(
      parseMcpConfigText(
        JSON.stringify({ servers: { files: { command: "npx" } } }),
      ),
    );
    expect(servers.format).toBe("servers");
    const registry = expectServers(
      parseMcpConfigText(
        JSON.stringify({
          name: "acme/files",
          version: "1.0.0",
          packages: [{ registryType: "npm", identifier: "files" }],
        }),
      ),
    );
    expect(registry.format).toBe("registry");
    // A bare entry imports fine but matches no export format.
    const bare = expectServers(
      parseMcpConfigText(JSON.stringify({ command: "npx" })),
    );
    expect(bare.format).toBeUndefined();
  });
});
