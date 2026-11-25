"use client";

import { Cable } from "lucide-react";
import { useEffect, useState } from "react";
import { ClientIcon } from "@/app/connection/client-icon";
import type { ConnectClient } from "@/app/connection/clients";
import { useDocsScreenshotMode } from "@/lib/docs-screenshot-mode";
import { useSeenNavItems } from "@/lib/onboarding/onboarding.query";
import { useShellReady } from "@/lib/shell-deferral";
import { cn } from "@/lib/utils/tailwind";

/**
 * The Connect row's icon: the logos of the clients Connect supports, one after
 * another, so the row shows what it connects before it is opened.
 *
 * The logos are an introduction, so they play only until the reader has opened
 * Connect once; from then on the row has the plain cable, as it does before
 * the logos load and where a moving icon is unwanted: the docs screenshots and
 * readers who asked for reduced motion.
 */
export function ConnectNavIcon({ className }: { className?: string }) {
  const docsScreenshotMode = useDocsScreenshotMode();
  const neverOpened = useConnectNeverOpened();
  const clients = useClientsWithLogo(!docsScreenshotMode && neverOpened);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (clients.length < 2) return;
    const timer = setInterval(
      () => setIndex((current) => (current + 1) % clients.length),
      LOGO_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [clients.length]);

  const client = clients[index];
  if (!client) return <Cable className={className} />;
  return (
    <span
      // Remounting per client replays the fade for each logo.
      key={client.id}
      aria-hidden="true"
      // One pixel wider than the 16px icons of the other rows on each side,
      // taken back by the margin so the labels stay aligned.
      className={cn(
        "-m-px flex shrink-0 animate-in fade-in-0 zoom-in-90 duration-300",
        className,
      )}
    >
      <ClientIcon client={client} size={LOGO_SIZE_PX} />
    </span>
  );
}

/**
 * Whether the reader has yet to open Connect: the same record that clears the
 * row's onboarding dot. Unknown counts as opened, so the logos never start and
 * then stop on a reader who has been there.
 */
function useConnectNeverOpened(): boolean {
  const { data, isSuccess } = useSeenNavItems({ enabled: useShellReady() });
  return isSuccess && !data.items.includes(CONNECT_NAV_KEY);
}

const CONNECT_NAV_KEY = "nav:connect";
const LOGO_INTERVAL_MS = 2000;
const LOGO_SIZE_PX = 18;

/**
 * The clients that have a logo to show. The client list is loaded after the
 * first paint: it carries every client's setup steps, which the sidebar on
 * every page should not wait for.
 */
function useClientsWithLogo(enabled: boolean): ConnectClient[] {
  const [clients, setClients] = useState<ConnectClient[]>([]);

  useEffect(() => {
    if (!enabled) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let cancelled = false;
    void import("@/app/connection/clients").then(({ CONNECT_CLIENTS }) => {
      if (cancelled) return;
      // Products of one vendor share a logo (Claude Code and Claude
      // Desktop): the rotation shows each logo once.
      const byLogo = new Map<string, ConnectClient>();
      for (const client of CONNECT_CLIENTS) {
        const logo = client.iconSrc ?? client.svg;
        if (logo && !byLogo.has(logo)) byLogo.set(logo, client);
      }
      setClients([...byLogo.values()]);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return enabled ? clients : [];
}
