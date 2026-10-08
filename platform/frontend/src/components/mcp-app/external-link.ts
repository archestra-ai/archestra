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

    let normalized = `slack://channel?team=${encodeURIComponent(team)}&id=${encodeURIComponent(channel)}`;
    // Optional message/thread anchors let apps open a thread pane directly.
    // Both are Slack timestamps; anything else drops the anchors entirely.
    const message = parsed.searchParams.get("message");
    const threadTs = parsed.searchParams.get("thread_ts");
    if (message && SLACK_TS.test(message)) {
      normalized += `&message=${message}`;
      if (threadTs && SLACK_TS.test(threadTs)) {
        normalized += `&thread_ts=${threadTs}`;
      }
    }
    return normalized;
  } catch {
    return null;
  }
}

const WEB_PROTOCOLS = new Set(["http:", "https:"]);
const SLACK_ID = /^[A-Z][A-Z0-9]+$/;
const SLACK_TS = /^\d+\.\d+$/;
