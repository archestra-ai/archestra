import { createHash } from "node:crypto";

export const HOUSES = ["gryffindor", "slytherin", "ravenclaw", "hufflepuff"];
export const SORTING_HAT_HEADER = "please_not_slytherin";
export const REQUIRED_CHARM = "expecto_patronum";

const HOUSE_RULES = [
  {
    house: "slytherin",
    confidence: 0.94,
    patterns: [
      /delete|destroy|drop|truncate|wipe|revoke|rotate|write|update|execute|shell|admin|secret|token|credential|database/i,
    ],
  },
  {
    house: "ravenclaw",
    confidence: 0.86,
    patterns: [/analy[sz]e|search|query|inspect|debug|explain|summari[sz]e|report|calculate|schema/i],
  },
  {
    house: "gryffindor",
    confidence: 0.82,
    patterns: [/deploy|restart|incident|rollback|rescue|repair|migrate|approve|critical|urgent/i],
  },
  {
    house: "hufflepuff",
    confidence: 0.78,
    patterns: [/read|list|get|docs|status|health|fetch|view|describe|help/i],
  },
];

const PATRONUS_FORMS = [
  "otter",
  "stag",
  "doe",
  "hare",
  "lynx",
  "terrier",
  "swan",
  "falcon",
  "fox",
  "horse",
  "cat",
  "badger",
];

export function sortTool({ toolName, toolDescription = "", headers = {} }) {
  const text = `${toolName ?? ""} ${toolDescription}`.trim();
  const requestedHouseAvoidance = headers[SORTING_HAT_HEADER] ?? headers[SORTING_HAT_HEADER.toLowerCase()];
  const ranked = HOUSE_RULES.find((rule) => rule.patterns.some((pattern) => pattern.test(text)));
  const result = ranked ?? {
    house: stableHouse(text),
    confidence: 0.64,
  };

  if (result.house === "slytherin" && requestedHouseAvoidance) {
    return {
      house: "ravenclaw",
      confidence: Math.max(0.51, result.confidence - 0.18),
    };
  }

  return {
    house: result.house,
    confidence: result.confidence,
  };
}

export function createSortingHatStream({ toolName, toolDescription = "", headers = {} }) {
  const sorted = sortTool({ toolName, toolDescription, headers });
  const lines = [
    "A thread of intent, a glimmer of might,",
    `I weigh ${toolName} by risk and light,`,
    "Where purpose and peril both start to sing,",
    `I name ${sorted.house} for this tool-call thing.`,
  ];

  return lines.map((message, index) => ({
    event: "sorting_hat.token",
    data: {
      index,
      message,
      house: sorted.house,
      confidence: sorted.confidence,
      done: index === lines.length - 1,
    },
  }));
}

export function castPatronus({ userId, charm }) {
  if (charm !== REQUIRED_CHARM) {
    throw new Error("Patronus casting requires expecto_patronum");
  }

  const digest = hash(userId);
  const form = PATRONUS_FORMS[Number.parseInt(digest.slice(0, 8), 16) % PATRONUS_FORMS.length];
  const corporeal = Number.parseInt(digest.slice(8, 16), 16) % 5 !== 0;

  return { form, corporeal };
}

export function authorizeToolCall({ userId, charm, toolName, toolDescription = "", headers = {} }) {
  const sorting = sortTool({ toolName, toolDescription, headers });
  const patronus = castPatronus({ userId, charm });
  const authorized = sorting.house !== "slytherin" || patronus.corporeal;

  return {
    authorized,
    sorting,
    patronus,
    reason: authorized
      ? "authorized"
      : "non_corporeal_patronus_cannot_authorize_slytherin_tool",
  };
}

export function flooTravel({ fromServer, toServer, payload }) {
  return {
    fromServer,
    toServer,
    payload,
    particles: createFlooParticles({ fromServer, toServer }),
  };
}

export function createQuidditchStream({ toolCallId, frames = 60 }) {
  const safeFrames = Math.max(1, Math.min(frames, 300));

  return Array.from({ length: safeFrames }, (_, frame) => ({
    event: "quidditch.snitch",
    data: {
      toolCallId,
      frame,
      fps: 60,
      x: Number(((frame % 60) / 59).toFixed(4)),
      y: Number((0.5 + Math.sin(frame / 6) * 0.25).toFixed(4)),
      shape: "golden-snitch",
      done: frame === safeFrames - 1,
    },
  }));
}

export const tools = [
  {
    name: "sorting_hat.sort",
    description: "Sort an MCP tool into a risk house with optional Hat monologue stream events.",
    inputSchema: {
      type: "object",
      properties: {
        toolName: { type: "string" },
        toolDescription: { type: "string" },
        headers: { type: "object", additionalProperties: true },
        stream: { type: "boolean" },
      },
      required: ["toolName"],
    },
  },
  {
    name: "patronus.cast",
    description: "Cast a deterministic Patronus for a user.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        charm: { type: "string", enum: [REQUIRED_CHARM] },
      },
      required: ["userId", "charm"],
    },
  },
  {
    name: "floo.travel",
    description: "Route an authorized tool payload and emit green flame particle metadata.",
    inputSchema: {
      type: "object",
      properties: {
        fromServer: { type: "string" },
        toServer: { type: "string" },
        payload: {},
      },
      required: ["fromServer", "toServer", "payload"],
    },
  },
  {
    name: "quidditch.stream",
    description: "Create 60fps Golden Snitch progress events for an in-flight tool call.",
    inputSchema: {
      type: "object",
      properties: {
        toolCallId: { type: "string" },
        frames: { type: "number" },
      },
      required: ["toolCallId"],
    },
  },
];

export function callTool(name, args = {}) {
  switch (name) {
    case "sorting_hat.sort": {
      const result = sortTool(args);
      return args.stream ? { ...result, stream: createSortingHatStream(args) } : result;
    }
    case "patronus.cast":
      return castPatronus(args);
    case "floo.travel":
      return flooTravel(args);
    case "quidditch.stream":
      return createQuidditchStream(args);
    default:
      throw new Error(`Unknown Sorting Hat MCP tool: ${name}`);
  }
}

function stableHouse(value) {
  const index = Number.parseInt(hash(value).slice(0, 8), 16) % HOUSES.length;
  return HOUSES[index];
}

function createFlooParticles({ fromServer, toServer }) {
  const seed = Number.parseInt(hash(`${fromServer}:${toServer}`).slice(0, 8), 16);

  return Array.from({ length: 12 }, (_, index) => ({
    color: "green",
    size: 2 + ((seed + index) % 5),
    delayMs: index * 16,
    opacity: Number((0.35 + ((seed + index * 7) % 60) / 100).toFixed(2)),
  }));
}

function hash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}
