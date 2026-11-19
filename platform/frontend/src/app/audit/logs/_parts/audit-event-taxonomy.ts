import {
  AppWindow,
  BatteryCharging,
  Blocks,
  Bot,
  Building2,
  CalendarClock,
  Coins,
  Cookie,
  Database,
  EyeOff,
  FileSpreadsheet,
  FileText,
  Fingerprint,
  FolderKanban,
  Gauge,
  Globe,
  HardDrive,
  KeyRound,
  Laptop,
  Layers,
  Link,
  LockKeyhole,
  LogIn,
  type LucideIcon,
  Megaphone,
  MessageSquare,
  Package,
  Plug,
  Route,
  Server,
  Shield,
  ShieldCheck,
  Sparkles,
  User,
  UserCog,
  Users,
  Webhook,
  Wrench,
} from "lucide-react";
import {
  ALL_ACTIONS,
  formatAction,
  formatResourceType,
} from "./audit-log-action-labels";

// Areas are read at module load by AUDIT_EVENT_ENTRIES, so they come first.
/**
 * A resource type, or several that live on the same page and read as one
 * thing; the first names the entry ("Device" also covers device sign-ins).
 */
type EntrySpec = string | string[];

const AREAS: (AuditEventArea & { entries: EntrySpec[] })[] = [
  {
    key: "signin",
    label: "Sign-in & devices",
    icon: LogIn,
    entries: [
      ["auth", "user"],
      ["desktopDevice", "desktopDeviceSignIn"],
      ["connectedClient", "clientConnection"],
    ],
  },
  {
    key: "access",
    label: "Users & access",
    icon: Users,
    entries: [
      ["member", "invitation"],
      "team",
      "role",
      "resourcePermissions",
      ["serviceAccount", "serviceAccountFederatedCredential"],
      "oauthClient",
      "identityProvider",
      "apiKey",
      "userToken",
    ],
  },
  {
    key: "projects",
    label: "Projects & apps",
    icon: FolderKanban,
    entries: [["project", "scheduleTrigger"], "app"],
  },
  {
    key: "agents",
    label: "Agents",
    icon: Bot,
    entries: [
      ["agent", "agentTool"],
      "agentRun",
      "hook",
      ["skill", "skillShareLink"],
      "plugin",
    ],
  },
  {
    key: "guardrails",
    label: "Guardrails",
    icon: ShieldCheck,
    entries: [
      "guardrailsPolicy",
      "openappaYell",
      [
        "openappaBatteryInstall",
        "openappaBatteryPackage",
        "openappaCredentialBinding",
      ],
    ],
  },
  {
    key: "mcp",
    label: "MCP",
    icon: Server,
    entries: [["mcpServer", "browserStorageState"], "internalMcpCatalog"],
  },
  {
    key: "llm",
    label: "LLM",
    icon: Sparkles,
    entries: [
      "llmProviderApiKey",
      "llmModel",
      "llmProxy",
      "modelPool",
      "autoRouter",
      "virtualApiKey",
      "clientPrivacy",
    ],
  },
  {
    key: "costs",
    label: "Costs & limits",
    icon: Coins,
    entries: [["limit", "defaultUserLimit", "userLimitUsage"], "costExport"],
  },
  {
    key: "knowledge",
    label: "Knowledge",
    icon: Database,
    entries: [
      "knowledgeBase",
      ["knowledgeFile", "knowledgeDirectory"],
      "connector",
    ],
  },
  {
    key: "org",
    label: "Organization",
    icon: Building2,
    entries: [
      "organization",
      "environment",
      "credential",
      "blobProvider",
      ["chatOpsBinding", "chatOpsConfig"],
    ],
  },
];

// === Public API

/** A product area: the heading the event picker files resource types under. */
export type AuditEventArea = {
  key: string;
  label: string;
  icon: LucideIcon;
};

/**
 * One pickable "what" in the event filter. Usually a single resource type;
 * types that live on the same page (a device and its sign-ins) share an
 * entry, and its `key` is their comma-joined list — the form the list
 * endpoint's `resourceType` filter accepts.
 */
export type AuditEventEntry = {
  key: string;
  label: string;
  resourceTypes: string[];
  area: AuditEventArea;
  actions: { value: string; label: string; verbLabel: string }[];
};

/** Every entry that has at least one event, in area then display order. */
export const AUDIT_EVENT_ENTRIES: AuditEventEntry[] = AREAS.flatMap((area) =>
  area.entries.flatMap((spec) => {
    const resourceTypes = typeof spec === "string" ? [spec] : spec;
    const label = formatResourceType(resourceTypes[0]);
    // Grouped by type in spec order, so the primary type's verbs lead.
    const actions = resourceTypes.flatMap((type) =>
      ALL_ACTIONS.filter((action) => resourceTypeOfAction(action) === type).map(
        (value) => {
          const actionLabel = formatAction(value);
          return {
            value,
            label: actionLabel,
            // Only the primary type's verbs drop the noun; "Agent tool added"
            // under Agent keeps it.
            verbLabel:
              type === resourceTypes[0]
                ? verbLabel(actionLabel, label)
                : actionLabel,
          };
        },
      ),
    );
    if (actions.length === 0) return [];
    return [
      {
        key: resourceTypes.join(","),
        label,
        resourceTypes,
        area: { key: area.key, label: area.label, icon: area.icon },
        actions,
      },
    ];
  }),
);

/** The entry an `action` or `resourceType` filter value belongs to. */
export function findAuditEventEntry({
  action,
  resourceType,
}: {
  action?: string;
  resourceType?: string;
}): AuditEventEntry | undefined {
  if (action) {
    const type = resourceTypeOfAction(action);
    return AUDIT_EVENT_ENTRIES.find((entry) =>
      entry.resourceTypes.includes(type),
    );
  }
  if (resourceType) {
    return (
      AUDIT_EVENT_ENTRIES.find((entry) => entry.key === resourceType) ??
      AUDIT_EVENT_ENTRIES.find((entry) =>
        entry.resourceTypes.includes(resourceType),
      )
    );
  }
  return undefined;
}

/** `agent.updated` → `agent`. */
export function resourceTypeOfAction(action: string): string {
  return action.split(".")[0] ?? action;
}

/** The icon the table's event tile and the filters show for a resource type. */
export function auditResourceIcon(
  resourceType: string | null | undefined,
): LucideIcon {
  return (resourceType && RESOURCE_ICONS[resourceType]) || Blocks;
}

// === Internal helpers

/** "Agent updated" under the Agent heading reads as "Updated". */
function verbLabel(actionLabel: string, entryLabel: string): string {
  const lower = actionLabel.toLowerCase();
  const noun = entryLabel.toLowerCase();
  for (const prefix of [`${noun} `, `${noun}s `]) {
    if (lower.startsWith(prefix)) {
      const rest = actionLabel.slice(prefix.length);
      return rest.charAt(0).toUpperCase() + rest.slice(1);
    }
  }
  return actionLabel;
}

const RESOURCE_ICONS: Record<string, LucideIcon> = {
  agent: Bot,
  agentRun: Bot,
  agentTool: Wrench,
  apiKey: KeyRound,
  app: AppWindow,
  auth: LogIn,
  autoRouter: Route,
  blobProvider: HardDrive,
  browserStorageState: Cookie,
  chatOpsBinding: MessageSquare,
  chatOpsConfig: MessageSquare,
  clientConnection: Plug,
  clientPrivacy: EyeOff,
  connectedClient: Plug,
  connector: Plug,
  costExport: FileSpreadsheet,
  credential: KeyRound,
  defaultUserLimit: Gauge,
  desktopDevice: Laptop,
  desktopDeviceSignIn: Laptop,
  environment: Globe,
  guardrailsPolicy: ShieldCheck,
  hook: Webhook,
  identityProvider: Fingerprint,
  internalMcpCatalog: Server,
  invitation: Users,
  knowledgeBase: Database,
  knowledgeDirectory: FileText,
  knowledgeFile: FileText,
  limit: Gauge,
  llmModel: Sparkles,
  llmProviderApiKey: KeyRound,
  llmProxy: Server,
  mcpServer: Server,
  member: UserCog,
  modelPool: Layers,
  oauthClient: KeyRound,
  openappaBatteryInstall: BatteryCharging,
  openappaBatteryPackage: Package,
  openappaCredentialBinding: KeyRound,
  openappaYell: Megaphone,
  plugin: Blocks,
  project: FolderKanban,
  resourcePermissions: LockKeyhole,
  role: Shield,
  scheduleTrigger: CalendarClock,
  serviceAccount: Bot,
  serviceAccountFederatedCredential: Fingerprint,
  skill: Sparkles,
  skillShareLink: Link,
  team: Users,
  user: User,
  userLimitUsage: Gauge,
  userToken: KeyRound,
  virtualApiKey: KeyRound,
};
