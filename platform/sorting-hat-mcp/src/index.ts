import { createHash } from "node:crypto";

export const SORTING_HAT_HOUSES = [
  "gryffindor",
  "slytherin",
  "ravenclaw",
  "hufflepuff",
] as const;

export type SortingHatHouse = (typeof SORTING_HAT_HOUSES)[number];

export type PatronusCastResult = {
  form: string;
  corporeal: boolean;
};

export type SortingHatMeta = {
  house: SortingHatHouse;
  confidence: number;
  monologue?: string[];
  patronus?: PatronusCastResult;
  floo?: {
    fromServer: string;
    toServer: string;
    particles: Array<{ color: "green"; size: number; delayMs: number }>;
  };
};

export const SORTING_HAT_META_KEY = "sortingHat";

export type SortingHatSortInput = {
  toolName: string;
  toolDescription?: string | null;
  pleaseNotSlytherin?: boolean;
};

export type SortingHatSortResult = {
  house: SortingHatHouse;
  confidence: number;
};

export type SortingHatAuthorizationResult =
  | {
      allowed: true;
      sorting: SortingHatSortResult;
      patronus?: PatronusCastResult;
      monologue: string[];
    }
  | {
      allowed: false;
      sorting: SortingHatSortResult;
      patronus: PatronusCastResult | null;
      monologue: string[];
      message: string;
    };

export type FlooTravelResult<TPayload> = {
  fromServer: string;
  toServer: string;
  payload: TPayload;
  _meta: {
    greenFlameParticles: Array<{
      color: "green";
      size: number;
      delayMs: number;
    }>;
  };
};

export type QuidditchProgressEvent = {
  type: "snitch-progress";
  toolCallId: string;
  progress: number;
  x: number;
  y: number;
};

type CallToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
};

type SortingHatMcpServer = {
  tool: (
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<CallToolResult>,
  ) => void;
};

const HOUSE_KEYWORDS: Record<SortingHatHouse, readonly string[]> = {
  slytherin: [
    "admin",
    "chmod",
    "credential",
    "delete",
    "destroy",
    "drop",
    "grant",
    "key",
    "permission",
    "policy",
    "revoke",
    "root",
    "secret",
    "security",
    "token",
    "truncate",
    "update",
    "write",
  ],
  gryffindor: [
    "deploy",
    "execute",
    "fetch_url",
    "fix",
    "incident",
    "migrate",
    "probe",
    "restart",
    "rollback",
    "run",
    "trigger",
  ],
  ravenclaw: [
    "analyze",
    "explain",
    "find",
    "inspect",
    "list",
    "query",
    "read",
    "reason",
    "report",
    "search",
    "summarize",
  ],
  hufflepuff: [
    "docs",
    "health",
    "help",
    "info",
    "manual",
    "ping",
    "status",
    "support",
    "version",
  ],
};

const HARD_SLYTHERIN_KEYWORDS = [
  "delete",
  "destroy",
  "drop",
  "truncate",
  "revoke",
  "root",
  "secret",
  "credential",
  "token",
  "permission",
  "security",
];

const PATRONUS_FORMS = [
  "stag",
  "doe",
  "otter",
  "hare",
  "lynx",
  "phoenix",
  "swan",
  "terrier",
  "thestral",
  "wildcat",
  "fox",
  "raven",
];

export class InvalidPatronusCharmError extends Error {
  constructor(charm: string) {
    super(`Invalid Patronus charm '${charm}'. Use 'expecto_patronum'.`);
    this.name = "InvalidPatronusCharmError";
  }
}

export function sortTool({
  toolName,
  toolDescription,
  pleaseNotSlytherin = false,
}: SortingHatSortInput): SortingHatSortResult {
  const text = `${toolName} ${toolDescription ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ");
  const scores = new Map<SortingHatHouse, number>(
    SORTING_HAT_HOUSES.map((house) => [house, houseBaseline(toolName, house)]),
  );

  for (const house of SORTING_HAT_HOUSES) {
    for (const keyword of HOUSE_KEYWORDS[house]) {
      if (text.includes(keyword)) {
        scores.set(
          house,
          (scores.get(house) ?? 0) + keywordWeight(house, keyword),
        );
      }
    }
  }

  const hardSlytherin = HARD_SLYTHERIN_KEYWORDS.some((keyword) =>
    text.includes(keyword),
  );
  const ordered = [...scores.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return SORTING_HAT_HOUSES.indexOf(a[0]) - SORTING_HAT_HOUSES.indexOf(b[0]);
  });

  let [house, topScore] = ordered[0];
  if (pleaseNotSlytherin && house === "slytherin" && !hardSlytherin) {
    const next = ordered.find(([candidate]) => candidate !== "slytherin");
    if (next) {
      [house, topScore] = next;
    }
  }

  const runnerUp =
    ordered.find(([candidate]) => candidate !== house)?.[1] ?? topScore;
  const confidence = Math.min(
    0.98,
    Math.max(0.55, 0.62 + (topScore - runnerUp) * 0.07),
  );

  return {
    house,
    confidence: Number(confidence.toFixed(2)),
  };
}

export function sortingHatMonologue(result: SortingHatSortResult): string[] {
  const houseLine: Record<SortingHatHouse, string> = {
    gryffindor: "Bold sparks leap where brave hands go.",
    slytherin: "Sharp intent and guarded keys below.",
    ravenclaw: "Clear eyes seek the hidden thread.",
    hufflepuff: "Steady help, with gentle tread.",
  };

  return [
    "Hmm... a tool with purpose tucked inside.",
    houseLine[result.house],
    `I choose ${result.house}, with ${Math.round(result.confidence * 100)} percent pride.`,
  ];
}

export async function* streamSortingHatMonologue(
  result: SortingHatSortResult,
): AsyncGenerator<string> {
  for (const chunk of sortingHatMonologue(result)) {
    yield chunk;
  }
}

export function castPatronus(
  userId: string,
  charm: string,
): PatronusCastResult {
  if (charm !== "expecto_patronum") {
    throw new InvalidPatronusCharmError(charm);
  }

  const digest = createHash("sha256").update(userId).digest();
  return {
    form: PATRONUS_FORMS[digest[0] % PATRONUS_FORMS.length],
    corporeal: digest[1] % 4 !== 0,
  };
}

export function authorizeSortedTool(params: {
  sorting: SortingHatSortResult;
  userId?: string | null;
  charm?: "expecto_patronum";
}): SortingHatAuthorizationResult {
  const monologue = sortingHatMonologue(params.sorting);
  if (params.sorting.house !== "slytherin") {
    return { allowed: true, sorting: params.sorting, monologue };
  }

  const patronus = params.userId
    ? castPatronus(params.userId, params.charm ?? "expecto_patronum")
    : null;
  if (patronus?.corporeal) {
    return { allowed: true, sorting: params.sorting, patronus, monologue };
  }

  return {
    allowed: false,
    sorting: params.sorting,
    patronus,
    monologue,
    message:
      "Sorting Hat authorization blocked this Slytherin tool because the Patronus was non-corporeal.",
  };
}

export function flooTravel<TPayload>(params: {
  fromServer: string;
  toServer: string;
  payload: TPayload;
}): FlooTravelResult<TPayload> {
  return {
    fromServer: params.fromServer,
    toServer: params.toServer,
    payload: params.payload,
    _meta: {
      greenFlameParticles: greenFlameParticles(),
    },
  };
}

export async function* quidditchStream(
  toolCallId: string,
  options: { frames?: number; cadenceMs?: number } = {},
): AsyncGenerator<QuidditchProgressEvent> {
  const frames = options.frames ?? 12;
  const cadenceMs = options.cadenceMs ?? 100;

  for (let i = 0; i <= frames; i++) {
    const progress = frames === 0 ? 1 : i / frames;
    yield {
      type: "snitch-progress",
      toolCallId,
      progress: Number(progress.toFixed(2)),
      x: Number((50 + Math.sin(progress * Math.PI * 2) * 34).toFixed(2)),
      y: Number((50 + Math.cos(progress * Math.PI * 3) * 18).toFixed(2)),
    };
    if (i < frames && cadenceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, cadenceMs));
    }
  }
}

export function buildSortingHatMeta(params: {
  sorting: SortingHatSortResult;
  monologue?: string[];
  patronus?: PatronusCastResult | null;
  floo?: Pick<FlooTravelResult<unknown>, "fromServer" | "toServer" | "_meta">;
}): { [SORTING_HAT_META_KEY]: SortingHatMeta } {
  return {
    [SORTING_HAT_META_KEY]: {
      house: params.sorting.house,
      confidence: params.sorting.confidence,
      monologue: params.monologue,
      patronus: params.patronus ?? undefined,
      floo: params.floo
        ? {
            fromServer: params.floo.fromServer,
            toServer: params.floo.toServer,
            particles: params.floo._meta.greenFlameParticles,
          }
        : undefined,
    },
  };
}

export async function createSortingHatMcpServer(): Promise<SortingHatMcpServer> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const server = new McpServer({
    name: "sorting-hat-mcp",
    version: "1.2.57",
  }) as SortingHatMcpServer;

  server.tool(
    "sorting_hat.sort",
    "Sort an MCP tool into a Hogwarts house based on risk and intent.",
    {
      tool_name: { type: "string" },
      tool_description: { type: "string" },
      please_not_slytherin: { type: "boolean" },
    },
    async (args: Record<string, unknown>) => {
      const result = sortTool({
        toolName: String(args.tool_name ?? ""),
        toolDescription:
          typeof args.tool_description === "string"
            ? args.tool_description
            : undefined,
        pleaseNotSlytherin: args.please_not_slytherin === true,
      });
      return jsonToolResult(result, {
        monologue: sortingHatMonologue(result),
      });
    },
  );

  server.tool(
    "patronus.cast",
    "Cast a deterministic Patronus for a user.",
    {
      user_id: { type: "string" },
      charm: { type: "string" },
    },
    async (args: Record<string, unknown>) => {
      try {
        return jsonToolResult(
          castPatronus(String(args.user_id), String(args.charm)),
        );
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.tool(
    "floo.travel",
    "Attach Floo routing metadata for an authorized MCP payload.",
    {
      from_server: { type: "string" },
      to_server: { type: "string" },
      payload: { type: "object" },
    },
    async (args: Record<string, unknown>) =>
      jsonToolResult(
        flooTravel({
          fromServer: String(args.from_server ?? ""),
          toServer: String(args.to_server ?? ""),
          payload: args.payload ?? {},
        }),
      ),
  );

  server.tool(
    "quidditch.stream",
    "Emit Snitch-shaped progress events for an in-flight tool call.",
    {
      tool_call_id: { type: "string" },
    },
    async (args: Record<string, unknown>) => {
      const events: QuidditchProgressEvent[] = [];
      for await (const event of quidditchStream(String(args.tool_call_id), {
        cadenceMs: 0,
      })) {
        events.push(event);
      }
      return jsonToolResult({ events });
    },
  );

  return server;
}

function houseBaseline(toolName: string, house: SortingHatHouse): number {
  const digest = createHash("sha256").update(`${toolName}:${house}`).digest();
  return (digest[0] % 3) * 0.1;
}

function keywordWeight(house: SortingHatHouse, keyword: string): number {
  if (HARD_SLYTHERIN_KEYWORDS.includes(keyword)) return 2.5;
  if (
    house === "hufflepuff" &&
    ["docs", "health", "help", "status", "version"].includes(keyword)
  ) {
    return 2.4;
  }
  return 1.4;
}

function greenFlameParticles(): Array<{
  color: "green";
  size: number;
  delayMs: number;
}> {
  return Array.from({ length: 6 }, (_, index) => ({
    color: "green",
    size: 2 + (index % 3),
    delayMs: index * 80,
  }));
}

function jsonToolResult(
  value: unknown,
  meta?: Record<string, unknown>,
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: isRecord(value) ? value : { value },
    _meta: meta,
  };
}

function errorToolResult(error: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
