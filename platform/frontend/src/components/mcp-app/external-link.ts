export function normalizeMcpAppExternalUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (WEB_PROTOCOLS.has(parsed.protocol)) {
      return parsed.href;
    }

    if (
      parsed.protocol !== "slack:" ||
      parsed.hostname !== "channel" ||
      (parsed.pathname !== "" && parsed.pathname !== "/")
    ) {
      return null;
    }

    const team = parsed.searchParams.get("team");
    const channel = parsed.searchParams.get("id");
    if (!team || !channel || !SLACK_ID.test(team) || !SLACK_ID.test(channel)) {
      return null;
    }

    return `slack://channel?team=${encodeURIComponent(team)}&id=${encodeURIComponent(channel)}`;
  } catch {
    return null;
  }
}

const WEB_PROTOCOLS = new Set(["http:", "https:"]);
const SLACK_ID = /^[A-Z][A-Z0-9]+$/;
