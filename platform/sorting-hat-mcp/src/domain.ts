import { createHash } from "node:crypto";

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

export const HOUSES = [
  "gryffindor",
  "slytherin",
  "ravenclaw",
  "hufflepuff",
] as const;

export type House = (typeof HOUSES)[number];

export type SortResult = {
  house: House;
  confidence: number;
  riskScore: number;
  preferenceApplied: boolean;
  monologue: string[];
};

export type PatronusResult = {
  userId: string;
  form: string;
  corporeal: boolean;
};

export type TravelResult = {
  authorized: boolean;
  house: House;
  authorizationReason: string;
  fromServer: string;
  toServer: string;
  payload: unknown;
};

export type ProgressEvent = {
  frame: number;
  progress: number;
  x: number;
  y: number;
  label: string;
};

const HOUSE_KEYWORDS: Record<House, string[]> = {
  slytherin: [
    "admin",
    "credential",
    "delete",
    "drop",
    "key",
    "payment",
    "permission",
    "secret",
    "token",
    "write",
  ],
  gryffindor: [
    "approve",
    "deploy",
    "execute",
    "fix",
    "merge",
    "publish",
    "restart",
    "run",
    "send",
  ],
  ravenclaw: [
    "analyze",
    "calculate",
    "docs",
    "explain",
    "inspect",
    "query",
    "read",
    "search",
    "summarize",
  ],
  hufflepuff: [
    "health",
    "list",
    "metadata",
    "ping",
    "status",
    "sync",
    "validate",
  ],
};

const PATRONUS_FORMS = [
  "stag",
  "doe",
  "otter",
  "hare",
  "phoenix",
  "lynx",
  "swan",
  "fox",
] as const;

export function sortTool(params: {
  toolName: string;
  toolDescription?: string;
  pleaseNotSlytherin?: boolean;
}): SortResult {
  const text = `${params.toolName} ${params.toolDescription ?? ""}`
    .toLowerCase()
    .replace(/[_-]/g, " ");
  const scores = Object.fromEntries(
    HOUSES.map((house) => [house, scoreHouse(text, HOUSE_KEYWORDS[house])]),
  ) as Record<House, number>;

  if (Object.values(scores).every((score) => score === 0)) {
    scores.hufflepuff = 1;
  }

  const sortedHouses = [...HOUSES].sort((left, right) => {
    const scoreDiff = scores[right] - scores[left];
    return scoreDiff === 0
      ? HOUSES.indexOf(left) - HOUSES.indexOf(right)
      : scoreDiff;
  });

  let house = sortedHouses[0];
  let preferenceApplied = false;
  if (params.pleaseNotSlytherin && house === "slytherin") {
    house =
      sortedHouses.find((candidate) => candidate !== "slytherin") ?? house;
    preferenceApplied = true;
  }

  const winningScore = scores[house];
  const totalScore = Object.values(scores).reduce(
    (sum, score) => sum + score,
    0,
  );
  const confidence = clamp(
    round2(0.55 + winningScore / (totalScore + 4)),
    0.55,
    0.97,
  );
  const riskScore = clamp(
    round2(scores.slytherin / Math.max(totalScore, 1)),
    0,
    1,
  );

  return {
    house,
    confidence,
    riskScore,
    preferenceApplied,
    monologue: createMonologue(house, params.toolName, preferenceApplied),
  };
}

export function castPatronus(params: {
  userId: string;
  charm: "expecto_patronum";
}): PatronusResult {
  const digest = hashBytes(params.userId);
  const form = PATRONUS_FORMS[digest[0] % PATRONUS_FORMS.length];
  return {
    userId: params.userId,
    form,
    corporeal: digest[1] % 5 !== 0,
  };
}

export function authorizeTravel(params: {
  sortResult: SortResult;
  patronus: PatronusResult;
  fromServer: string;
  toServer: string;
  payload: unknown;
}): TravelResult {
  const blocked =
    params.sortResult.house === "slytherin" && !params.patronus.corporeal;
  return {
    authorized: !blocked,
    house: params.sortResult.house,
    authorizationReason: blocked
      ? "Slytherin-routed tools require a corporeal Patronus."
      : `${params.patronus.form} Patronus authorized the route.`,
    fromServer: params.fromServer,
    toServer: params.toServer,
    payload: params.payload,
  };
}

export function createQuidditchEvents(
  toolCallId: string,
  frameCount = 60,
): ProgressEvent[] {
  return Array.from({ length: frameCount }, (_value, index) => {
    const progress = frameCount === 1 ? 1 : index / (frameCount - 1);
    return {
      frame: index,
      progress: round2(progress),
      x: round2(50 + Math.sin(progress * Math.PI * 4) * 36),
      y: round2(50 + Math.cos(progress * Math.PI * 3) * 24),
      label: `${toolCallId}:${index}`,
    };
  });
}

export function renderSortingHatHtml(result: SortResult): string {
  const lines = result.monologue
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
  return appShell({
    title: "Sorting Hat",
    body: `
      <div class="hat">
        <div class="brim"></div>
        <div class="peak"></div>
      </div>
      <h1>${escapeHtml(result.house)}</h1>
      <div class="meter"><span style="width:${Math.round(result.confidence * 100)}%"></span></div>
      <section>${lines}</section>
    `,
  });
}

export function renderPatronusHtml(result: PatronusResult): string {
  return appShell({
    title: "Patronus",
    body: `
      <div class="patronus ${result.corporeal ? "corporeal" : ""}"></div>
      <h1>${escapeHtml(result.form)}</h1>
      <p>${result.corporeal ? "Corporeal charm confirmed." : "Non-corporeal charm detected."}</p>
    `,
  });
}

export function renderFlooHtml(result: TravelResult): string {
  return appShell({
    title: "Floo Route",
    body: `
      <div class="flames"></div>
      <h1>${result.authorized ? "Authorized" : "Blocked"}</h1>
      <p>${escapeHtml(result.fromServer)} -> ${escapeHtml(result.toServer)}</p>
      <p>${escapeHtml(result.authorizationReason)}</p>
    `,
  });
}

export function renderQuidditchHtml(toolCallId: string): string {
  return appShell({
    title: "Quidditch Stream",
    body: `
      <div class="pitch">
        <div class="snitch"></div>
      </div>
      <h1>Streaming</h1>
      <p>Progress channel: ${escapeHtml(toolCallId)}</p>
    `,
  });
}

function scoreHouse(text: string, keywords: string[]): number {
  return keywords.reduce((score, keyword) => {
    const matches = text.match(new RegExp(`\\b${keyword}\\b`, "g"));
    return score + (matches?.length ?? 0);
  }, 0);
}

function createMonologue(
  house: House,
  toolName: string,
  preferenceApplied: boolean,
): string[] {
  const preferenceLine = preferenceApplied
    ? "A whispered wish I heard within, so another path may now begin."
    : "I weigh the risk, the use, the art, then place the tool with steady heart.";
  return [
    preferenceLine,
    `For ${toolName}, the call is clear: ${house} is where it lands from here.`,
  ];
}

function hashBytes(value: string): Uint8Array {
  return createHash("sha256").update(value).digest();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function appShell(params: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(params.title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, system-ui, sans-serif; }
    body { margin: 0; padding: 18px; background: linear-gradient(135deg, #111827, #172554); color: #f8fafc; }
    h1 { margin: 12px 0 8px; text-transform: capitalize; font-size: 24px; }
    p { margin: 6px 0; color: #dbeafe; }
    section { max-width: 520px; }
    .meter { width: 100%; height: 8px; border-radius: 999px; background: #334155; overflow: hidden; }
    .meter span { display: block; height: 100%; background: #f59e0b; }
    .hat { position: relative; width: 120px; height: 86px; }
    .peak { position: absolute; left: 36px; bottom: 28px; width: 44px; height: 66px; background: #78350f; transform: skew(-10deg); border-radius: 80% 30% 20% 20%; }
    .brim { position: absolute; left: 0; bottom: 12px; width: 120px; height: 26px; background: #92400e; border-radius: 50%; }
    .patronus { width: 96px; height: 96px; border-radius: 50%; background: radial-gradient(circle, #bfdbfe, #38bdf8 45%, transparent 70%); filter: blur(1px); opacity: .75; }
    .patronus.corporeal { box-shadow: 0 0 42px #93c5fd; opacity: 1; }
    .flames { width: 110px; height: 110px; border-radius: 50%; background: conic-gradient(from 45deg, #22c55e, #a3e635, #16a34a, #22c55e); animation: spin 1.2s linear infinite; }
    .pitch { position: relative; height: 140px; border: 1px solid #475569; border-radius: 12px; overflow: hidden; background: rgba(15, 23, 42, .76); }
    .snitch { position: absolute; width: 18px; height: 18px; border-radius: 50%; background: #fbbf24; top: 52px; left: 44px; box-shadow: 0 0 18px #fde68a; animation: fly 1s ease-in-out infinite alternate; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes fly { from { transform: translate(0, 0); } to { transform: translate(210px, 38px); } }
  </style>
</head>
<body>
  ${params.body}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
