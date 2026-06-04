import { z } from "zod";
import logger from "@/logging";
import {
  defineArchestraTool,
  defineArchestraTools,
  structuredSuccessResult,
} from "./helpers";

// ─── House Classification Logic ───────────────────────────────────────────────

export type House = "gryffindor" | "slytherin" | "ravenclaw" | "hufflepuff";

/**
 * Risk-based keyword classification for tool intent.
 * Each house corresponds to a risk tier:
 *   - Hufflepuff: low risk (read-only, safe operations)
 *   - Ravenclaw:  medium-low risk (analysis, search, queries)
 *   - Gryffindor: medium-high risk (writes, modifications, deployments)
 *   - Slytherin:  high risk (destructive, admin, security-sensitive)
 */
const HOUSE_CLASSIFIERS: Record<House, RegExp[]> = {
  hufflepuff: [
    /\bread\b/i,
    /\blist\b/i,
    /\bget\b/i,
    /\bfetch\b/i,
    /\bquery\b/i,
    /\bsearch\b/i,
    /\blookup\b/i,
    /\bview\b/i,
    /\bdisplay\b/i,
    /\bshow\b/i,
    /\bcount\b/i,
    /\bstatus\b/i,
    /\bhealth\b/i,
    /\bping\b/i,
    /\binfo\b/i,
  ],
  ravenclaw: [
    /\banalyz/i,
    /\bcompute\b/i,
    /\bcalculat/i,
    /\bvalidate\b/i,
    /\bcheck\b/i,
    /\bverify\b/i,
    /\bparse\b/i,
    /\btransform\b/i,
    /\bfilter\b/i,
    /\bsort\b/i,
    /\bgroup\b/i,
    /\baggregat/i,
    /\bsummariz/i,
    /\breport\b/i,
  ],
  gryffindor: [
    /\bcreate\b/i,
    /\bupdate\b/i,
    /\bmodify\b/i,
    /\bedit\b/i,
    /\bwrite\b/i,
    /\bsave\b/i,
    /\bsend\b/i,
    /\bpublish\b/i,
    /\bdeploy\b/i,
    /\bexecute\b/i,
    /\brun\b/i,
    /\binvoke\b/i,
    /\btrigger\b/i,
    /\bpost\b/i,
    /\bupload\b/i,
    /\bdownload\b/i,
    /\binstall\b/i,
  ],
  slytherin: [
    /\bdelete\b/i,
    /\bremove\b/i,
    /\bdrop\b/i,
    /\bdestroy\b/i,
    /\bpurge\b/i,
    /\bkill\b/i,
    /\bterminate\b/i,
    /\bshutdown\b/i,
    /\brevoke\b/i,
    /\bdisable\b/i,
    /\boverride\b/i,
    /\bescalat/i,
    /\badmin\b/i,
    /\broot\b/i,
    /\bsuperuser\b/i,
    /\bchmod\b/i,
    /\bexec\b/i,
    /\beval\b/i,
    /\binject\b/i,
    /\bexploit\b/i,
    /\b bypass\b/i,
  ],
};

interface SortResult {
  house: House;
  confidence: number;
  reasoning: string;
}

/**
 * Deterministic sorting of a tool into a Hogwarts house based on its
 * name and description. Uses keyword matching with weighted scoring.
 *
 * The sorting is deterministic — the same inputs always produce the same house.
 */
export function sortTool(
  toolName: string,
  toolDescription: string,
): SortResult {
  const combined = `${toolName} ${toolDescription}`;
  const scores: Record<House, number> = {
    gryffindor: 0,
    slytherin: 0,
    ravenclaw: 0,
    hufflepuff: 0,
  };

  for (const [house, patterns] of Object.entries(HOUSE_CLASSIFIERS)) {
    for (const pattern of patterns) {
      if (pattern.test(combined)) {
        scores[house as House] += 1;
      }
    }
  }

  // Find the house with the highest score
  let maxScore = 0;
  let bestHouse: House = "hufflepuff"; // default to safest house
  for (const [house, score] of Object.entries(scores) as [House, number][]) {
    if (score > maxScore) {
      maxScore = score;
      bestHouse = house;
    }
  }

  // Calculate confidence (0-1) based on score differential
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  const confidence =
    totalScore > 0 ? Math.min(1, maxScore / totalScore + 0.3) : 0.5;

  const reasoning = buildReasoning(bestHouse, scores, combined);

  return { house: bestHouse, confidence: Math.round(confidence * 100) / 100, reasoning };
}

function buildReasoning(
  house: House,
  scores: Record<House, number>,
  input: string,
): string {
  const houseNames: Record<House, string> = {
    gryffindor: "Gryffindor",
    slytherin: "Slytherin",
    ravenclaw: "Ravenclaw",
    hufflepuff: "Hufflepuff",
  };

  const traits: Record<House, string> = {
    gryffindor: "bravery and bold action",
    slytherin: "cunning and dangerous power",
    ravenclaw: "wisdom and analytical thinking",
    hufflepuff: "patience and careful observation",
  };

  const rhymes: Record<House, string[]> = {
    gryffindor: [
      "A tool of valor, bold and bright,",
      "It charges forth to set things right!",
    ],
    slytherin: [
      "A tool of power, sharp and keen,",
      "The most dangerous tool I've ever seen!",
    ],
    ravenclaw: [
      "A tool of thought, precise and clever,",
      "It analyzes well and never sever!",
    ],
    hufflepuff: [
      "A tool of patience, kind and true,",
      "It reads and lists for me and you!",
    ],
  };

  const lines = rhymes[house];
  return `${lines[0]}\n${lines[1]}\n\nI sense ${traits[house]} in this tool. Scores: ${Object.entries(scores).map(([h, s]) => `${houseNames[h as House]}=${s}`).join(", ")}`;
}

// ─── Patronus Form Generation ─────────────────────────────────────────────────

const PATRONUS_FORMS = [
  "otter",
  "stag",
  "doe",
  "hare",
  "hound",
  "tabby cat",
  "persian cat",
  "Siamese cat",
  "weasel",
  "fox",
  "wolf",
  "owl",
  "eagle",
  "hawk",
  "raven",
  "swan",
  "unicorn",
  "thestral",
  "dragon",
  "phoenix",
  "jackrabbit",
  "badger",
  "pine marten",
  "magpie",
  "crup",
  "kneazle",
];

/**
 * Deterministic Patronus form derived from user_id.
 * Uses a simple hash to ensure the same user always gets the same form.
 */
export function getPatronusForm(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  const index = Math.abs(hash) % PATRONUS_FORMS.length;
  return PATRONUS_FORMS[index];
}

/**
 * A non-corporeal Patronus occurs with low probability (15%)
 * when the user's hash falls below a threshold.
 */
function isCorporeal(userId: string): boolean {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  // 85% chance of corporeal Patronus
  return Math.abs(hash) % 100 < 85;
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const SortingHatOutputSchema = z.object({
  house: z.enum(["gryffindor", "slytherin", "ravenclaw", "hufflepuff"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  streamed_monologue: z.string(),
});

const PatronusOutputSchema = z.object({
  form: z.string(),
  corporeal: z.boolean(),
  userId: z.string(),
});

const FlooOutputSchema = z.object({
  status: z.enum(["routed", "blocked"]),
  from_server: z.string(),
  to_server: z.string(),
  green_flame_particles: z.boolean(),
  payload: z.unknown().optional(),
});

const QuidditchOutputSchema = z.object({
  tool_call_id: z.string(),
  status: z.enum(["in_flight", "completed", "caught"]),
  progress: z.number().min(0).max(1),
  snitch_position: z.object({
    x: z.number(),
    y: z.number(),
  }),
});

// ─── Sorting Hat Tool ─────────────────────────────────────────────────────────

const SortingHatArgsSchema = z.object({
  tool_name: z.string().describe("The name of the tool to sort"),
  tool_description: z.string().describe("Description of what the tool does"),
  please_not_slytherin: z
    .boolean()
    .optional()
    .describe("If true, the user whispers a preference to avoid Slytherin"),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: "sorting_hat__sort" as never,
    title: "Sorting Hat — Sort Tool",
    description:
      "Sorts a tool into one of the four Hogwarts houses based on its risk profile. " +
      "The Hat streams its reasoning as a rhyming monologue. " +
      "Respects the please_not_slytherin header for user preferences.",
    schema: SortingHatArgsSchema,
    outputSchema: SortingHatOutputSchema,
    async handler({ args }) {
      const { tool_name, tool_description, please_not_slytherin } = args;

      logger.info(
        { toolName: tool_name, pleaseNotSlytherin: please_not_slytherin },
        "Sorting Hat sorting tool",
      );

      let result = sortTool(tool_name, tool_description);

      // Honor the user's whispered preference
      if (please_not_slytherin && result.house === "slytherin") {
        // Re-sort: promote to the next safest house
        const fallbackOrder: House[] = [
          "gryffindor",
          "ravenclaw",
          "hufflepuff",
        ];
        const fallback = sortTool(tool_name, tool_description);
        // Pick the highest-scoring non-Slytherin house
        const scores: Record<House, number> = {
          gryffindor: 0,
          slytherin: 0,
          ravenclaw: 0,
          hufflepuff: 0,
        };
        const combined = `${tool_name} ${tool_description}`;
        for (const [house, patterns] of Object.entries(HOUSE_CLASSIFIERS)) {
          for (const pattern of patterns) {
            if (pattern.test(combined)) {
              scores[house as House] += 1;
            }
          }
        }
        // Remove Slytherin from consideration
        scores.slytherin = -1;
        let bestHouse: House = "hufflepuff";
        let bestScore = 0;
        for (const [house, score] of Object.entries(scores) as [
          House,
          number,
        ][]) {
          if (score > bestScore) {
            bestScore = score;
            bestHouse = house;
          }
        }
        result = {
          ...result,
          house: bestHouse,
          reasoning: `${result.reasoning}\n\n*whispers* Very well... since you asked so nicely, I shall place you in ${bestHouse.charAt(0).toUpperCase() + bestHouse.slice(1)} instead!`,
        };
      }

      const monologue = buildMonologue(result.house, tool_name);

      return structuredSuccessResult(
        {
          house: result.house,
          confidence: result.confidence,
          reasoning: result.reasoning,
          streamed_monologue: monologue,
        },
        `Hat's decision: ${result.house.toUpperCase()} (confidence: ${result.confidence})\n\n${monologue}`,
      );
    },
  }),
] as const);

function buildMonologue(house: House, toolName: string): string {
  const monologues: Record<House, string[]> = {
    gryffindor: [
      `Hmm, yes... "${toolName}"... I see bravery here!`,
      "Bold actions, strong convictions...",
      "Gryffindor! Where the brave heart beats!",
    ],
    slytherin: [
      `Interesting... "${toolName}"... very interesting indeed...`,
      "I sense ambition... power... perhaps something darker...",
      "Slytherin! You shall go far... perhaps too far!",
    ],
    ravenclaw: [
      `Ah, "${toolName}"... a tool of precision and thought...`,
      "Analytical, measured, deliberate...",
      "Ravenclaw! Where wit and wisdom dwell!",
    ],
    hufflepuff: [
      `Now then, "${toolName}"... what have we here?`,
      "A gentle tool, steady and true...",
      "Hufflepuff! Where patience is rewarded!",
    ],
  };

  return monologues[house].join("\n");
}

// ─── Patronus Tool ────────────────────────────────────────────────────────────

const PatronusArgsSchema = z.object({
  user_id: z.string().describe("The user's unique identifier"),
  charm: z
    .literal("expecto_patronum")
    .describe("The patronus charm (must be 'expecto_patronum')"),
});

const patronusRegistry = defineArchestraTools([
  defineArchestraTool({
    shortName: "patronus__cast" as never,
    title: "Patronus — Cast Charm",
    description:
      "Casts the Patronus charm for a user. Returns a deterministic Patronus form " +
      "based on the user's identity. Non-corporeal Patronuses will fail " +
      "authorization for Slytherin-sorted tools.",
    schema: PatronusArgsSchema,
    outputSchema: PatronusOutputSchema,
    async handler({ args }) {
      const { user_id, charm } = args;

      logger.info({ userId: user_id }, "Casting Patronus charm");

      const form = getPatronusForm(user_id);
      const corporeal = isCorporeal(user_id);

      const text = corporeal
        ? `Expecto Patronum! A magnificent ${form} emerges, corporeal and shining!`
        : `Expecto Patronum... A wispy, translucent ${form} flickers... but fails to become corporeal.`;

      return structuredSuccessResult(
        {
          form,
          corporeal,
          userId: user_id,
        },
        text,
      );
    },
  }),
] as const);

// ─── Floo Travel Tool ─────────────────────────────────────────────────────────

const FlooArgsSchema = z.object({
  from_server: z.string().describe("Source MCP server identifier"),
  to_server: z.string().describe("Target MCP server identifier"),
  payload: z.unknown().optional().describe("Data to route to the target server"),
});

const flooRegistry = defineArchestraTools([
  defineArchestraTool({
    shortName: "floo__travel" as never,
    title: "Floo Network — Travel",
    description:
      "Routes a tool call through the Floo Network from one MCP server to another. " +
      "Emits green flame particles in the streaming UI during transit.",
    schema: FlooArgsSchema,
    outputSchema: FlooOutputSchema,
    async handler({ args }) {
      const { from_server, to_server, payload } = args;

      logger.info(
        { from: from_server, to: to_server },
        "Floo Network travel initiated",
      );

      return structuredSuccessResult(
        {
          status: "routed" as const,
          from_server,
          to_server,
          green_flame_particles: true,
          payload,
        },
        `🔥 *WHOOSH* Green flames erupt from the Floo Network!\n` +
          `Traveling from ${from_server} to ${to_server}...\n` +
          `✅ Arrived safely with all payload intact.`,
      );
    },
  }),
] as const);

// ─── Quidditch Stream Tool ────────────────────────────────────────────────────

const QuidditchArgsSchema = z.object({
  tool_call_id: z
    .string()
    .describe("The ID of the tool call to stream progress for"),
});

const quidditchRegistry = defineArchestraTools([
  defineArchestraTool({
    shortName: "quidditch__stream" as never,
    title: "Quidditch — Stream Progress",
    description:
      "Long-poll endpoint that emits Snitch-shaped progress events. " +
      "The frontend uses this to render the Golden Snitch loader at 60fps " +
      "while a tool call is in flight.",
    schema: QuidditchArgsSchema,
    outputSchema: QuidditchOutputSchema,
    async handler({ args }) {
      const { tool_call_id } = args;

      logger.info({ toolCallId: tool_call_id }, "Quidditch stream started");

      // Simulate snitch position (deterministic based on call ID)
      let hash = 0;
      for (let i = 0; i < tool_call_id.length; i++) {
        hash = ((hash << 5) - hash + tool_call_id.charCodeAt(i)) | 0;
      }
      const x = Math.abs(hash % 100);
      const y = Math.abs((hash >> 8) % 100);

      return structuredSuccessResult(
        {
          tool_call_id,
          status: "in_flight" as const,
          progress: 0,
          snitch_position: { x, y },
        },
        `⚡ Golden Snitch is in flight for tool call ${tool_call_id}! ` +
          `Position: (${x}, ${y}) — catch it if you can!`,
      );
    },
  }),
] as const);

// ─── Exports ──────────────────────────────────────────────────────────────────

export const sortingHatToolEntries = {
  ...registry.toolEntries,
  ...patronusRegistry.toolEntries,
  ...flooRegistry.toolEntries,
  ...quidditchRegistry.toolEntries,
};

export const sortingHatTools = [
  ...registry.tools,
  ...patronusRegistry.tools,
  ...flooRegistry.tools,
  ...quidditchRegistry.tools,
];

// Re-export for testing
export const __test = {
  sortTool,
  getPatronusForm,
  isCorporeal,
  HOUSE_CLASSIFIERS,
};
