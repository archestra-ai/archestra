// Mock data for Connect prototypes. Shapes are deliberately loose and
// prototype-owned: add fields here when a variant needs them rather than
// wiring a prototype to the real API before its direction is picked.

export type PrototypePersona = "end-user" | "admin";

export interface MockServer {
  id: string;
  name: string;
  category: string;
  toolCount: number;
  /** False when the user still has to sign in to the integration. */
  authenticated: boolean;
  exampleAsk?: string;
}

export interface MockSkill {
  id: string;
  name: string;
  description: string;
}

export interface MockConnectedAgent {
  id: string;
  clientId: string;
  clientLabel: string;
  status: "instructions-ready" | "authorized" | "verified";
  firstConnectedAt: string;
  lastUsedAt: string | null;
  addOns: string[];
}

export interface MockOrgAdoption {
  totalUsers: number;
  connectedUsers: number;
  activeThisWeek: number;
}

export interface ConnectScenario {
  id: string;
  label: string;
  summary: string;
  userName: string;
  servers: MockServer[];
  skills: MockSkill[];
  connectedAgents: MockConnectedAgent[];
  adoption: MockOrgAdoption;
}

const TYPICAL_SERVERS: MockServer[] = [
  {
    id: "slack",
    name: "Slack",
    category: "Communication",
    toolCount: 12,
    authenticated: true,
    exampleAsk: "Summarize what I missed in #incidents today",
  },
  {
    id: "jira",
    name: "Jira",
    category: "Project management",
    toolCount: 18,
    authenticated: true,
    exampleAsk: "List my open tickets for this sprint",
  },
  {
    id: "github",
    name: "GitHub",
    category: "Engineering",
    toolCount: 26,
    authenticated: false,
    exampleAsk: "Open a PR for ticket ABC-123",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    category: "Documents",
    toolCount: 9,
    authenticated: true,
    exampleAsk: "Find the latest Q3 planning doc",
  },
];

const TYPICAL_SKILLS: MockSkill[] = [
  {
    id: "incident-review",
    name: "Incident review",
    description: "Drafts a postmortem from Slack threads and Jira tickets.",
  },
  {
    id: "pr-hygiene",
    name: "PR hygiene",
    description: "Writes conventional PR titles and test plans.",
  },
];

const TYPICAL_ADOPTION: MockOrgAdoption = {
  totalUsers: 140,
  connectedUsers: 38,
  activeThisWeek: 21,
};

function generateServers(count: number): MockServer[] {
  const categories = [
    "Communication",
    "Engineering",
    "Documents",
    "Data",
    "Finance",
    "Support",
  ];
  return Array.from({ length: count }, (_, index) => ({
    id: `server-${index + 1}`,
    name: `Internal service ${index + 1}`,
    category: categories[index % categories.length],
    toolCount: 3 + (index % 20),
    authenticated: index % 7 !== 0,
  }));
}

function generateSkills(count: number): MockSkill[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `skill-${index + 1}`,
    name: `Team skill ${index + 1}`,
    description: "A team-authored skill shared through the marketplace.",
  }));
}

export const CONNECT_SCENARIOS: ConnectScenario[] = [
  {
    id: "first-visit",
    label: "First visit",
    summary: "A handful of servers and skills, no agent connected yet.",
    userName: "Sam",
    servers: TYPICAL_SERVERS,
    skills: TYPICAL_SKILLS,
    connectedAgents: [],
    adoption: TYPICAL_ADOPTION,
  },
  {
    id: "returning",
    label: "Returning user",
    summary: "Same gateway, two agents already connected.",
    userName: "Sam",
    servers: TYPICAL_SERVERS,
    skills: TYPICAL_SKILLS,
    connectedAgents: [
      {
        id: "agent-1",
        clientId: "claude-code",
        clientLabel: "Claude Code",
        status: "verified",
        firstConnectedAt: "2026-09-14T09:12:00Z",
        lastUsedAt: "2026-10-02T15:40:00Z",
        addOns: ["Skills"],
      },
      {
        id: "agent-2",
        clientId: "cursor",
        clientLabel: "Cursor",
        status: "authorized",
        firstConnectedAt: "2026-09-30T13:05:00Z",
        lastUsedAt: null,
        addOns: [],
      },
    ],
    adoption: TYPICAL_ADOPTION,
  },
  {
    id: "empty-gateway",
    label: "Empty gateway",
    summary: "The user has access to nothing yet.",
    userName: "Sam",
    servers: [],
    skills: [],
    connectedAgents: [],
    adoption: { totalUsers: 140, connectedUsers: 0, activeThisWeek: 0 },
  },
  {
    id: "at-scale",
    label: "At scale",
    summary: "1,200 servers, 300 skills, 1,300 users.",
    userName: "Sam",
    servers: generateServers(1200),
    skills: generateSkills(300),
    connectedAgents: [],
    adoption: { totalUsers: 1300, connectedUsers: 412, activeThisWeek: 260 },
  },
];

export const DEFAULT_SCENARIO_ID = CONNECT_SCENARIOS[0].id;
