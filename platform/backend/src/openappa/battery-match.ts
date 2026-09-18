import type { InternalMcpCatalog } from "@/types";

type BatteryMatchCatalog = Pick<
  InternalMcpCatalog,
  "name" | "serverUrl" | "localConfig"
>;

/**
 * The batteries a catalog entry stands for, strongest evidence first: a known
 * server URL host or container image outweighs a name, and a name match only
 * counts when no stronger match exists. Only batteries in `available` qualify.
 */
export function matchBatteries(
  catalog: BatteryMatchCatalog,
  available: ReadonlySet<string>,
): string[] {
  const host = urlHost(catalog.serverUrl);
  const image = imageRepository(catalog.localConfig?.dockerImage);
  const name = ` ${normalizeName(catalog.name)} `;
  const strong: string[] = [];
  const weak: string[] = [];
  for (const rule of BATTERY_MATCH_RULES) {
    if (!available.has(rule.battery)) continue;
    const byHost =
      host !== null &&
      rule.hosts.some((known) => host === known || host.endsWith(`.${known}`));
    const byImage =
      image !== null &&
      rule.images.some(
        (known) => image === known || image.startsWith(`${known}/`),
      );
    if (byHost || byImage) strong.push(rule.battery);
    else if (rule.names.some((alias) => name.includes(` ${alias} `)))
      weak.push(rule.battery);
  }
  return strong.length > 0 ? strong : weak;
}

type BatteryMatchRule = {
  battery: string;
  /** Server URL hosts, matched exactly or as a parent domain. */
  hosts: string[];
  /** Container image repositories without a tag, matched exactly or as a prefix path. */
  images: string[];
  /** Normalized catalog-name fragments (lower case, single spaces), matched on word boundaries. */
  names: string[];
};

const BATTERY_MATCH_RULES: BatteryMatchRule[] = [
  {
    battery: "cloudflare",
    hosts: ["mcp.cloudflare.com"],
    images: [],
    names: ["cloudflare"],
  },
  {
    battery: "databricks",
    hosts: ["databricks.com", "azuredatabricks.net"],
    images: [],
    names: ["databricks"],
  },
  {
    battery: "github",
    hosts: ["api.githubcopilot.com", "github.com"],
    images: ["ghcr.io/github/github-mcp-server", "mcp/github"],
    names: ["github"],
  },
  {
    battery: "google-workspace",
    hosts: [],
    images: [],
    names: ["google workspace", "gmail", "google drive", "google calendar"],
  },
  { battery: "grain", hosts: ["grain.com"], images: [], names: ["grain"] },
  {
    battery: "huggingface",
    hosts: ["huggingface.co", "hf.co"],
    images: [],
    names: ["hugging face", "huggingface"],
  },
  {
    battery: "launchdarkly",
    hosts: ["launchdarkly.com"],
    images: [],
    names: ["launchdarkly", "launch darkly"],
  },
  {
    battery: "linear",
    hosts: ["mcp.linear.app", "linear.app"],
    images: [],
    names: ["linear"],
  },
  {
    battery: "microsoft-learn",
    hosts: ["learn.microsoft.com"],
    images: [],
    names: ["microsoft learn", "ms learn", "mslearn"],
  },
  {
    battery: "notion",
    hosts: ["mcp.notion.com", "notion.so", "notion.com"],
    images: ["mcp/notion"],
    names: ["notion"],
  },
  {
    battery: "pagerduty",
    hosts: ["pagerduty.com"],
    images: [],
    names: ["pagerduty", "pager duty"],
  },
  {
    battery: "posthog",
    hosts: ["mcp.posthog.com", "posthog.com"],
    images: [],
    names: ["posthog"],
  },
  {
    battery: "slack",
    hosts: ["slack.com"],
    images: ["mcp/slack"],
    names: ["slack"],
  },
];

function urlHost(serverUrl: string | null): string | null {
  if (!serverUrl) return null;
  try {
    return new URL(serverUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function imageRepository(image: string | undefined): string | null {
  if (!image) return null;
  const withoutDigest = image.split("@")[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const tagIndex = withoutDigest.indexOf(":", lastSlash + 1);
  return (
    tagIndex === -1 ? withoutDigest : withoutDigest.slice(0, tagIndex)
  ).toLowerCase();
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
