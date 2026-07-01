"use client";

import { Terminal } from "lucide-react";
import type { ConnectClient } from "./clients";

interface ClientIconProps {
  client: ConnectClient;
  size?: number;
}

export function ClientIcon({ client, size = 36 }: ClientIconProps) {
  const radius = Math.round(size / 4.25);
  return (
    <div
      className="flex shrink-0 items-center justify-center border"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: client.tileBg || "var(--muted)",
      }}
    >
      {client.svg ? (
        <svg
          viewBox="0 0 24 24"
          width={size * 0.6}
          height={size * 0.6}
          role="img"
          aria-label={`${client.label} logo`}
        >
          <path d={client.svg} fill={client.iconColor || "currentColor"} />
        </svg>
      ) : client.iconOverride ? (
        <div
          className="flex size-full items-center justify-center font-mono font-bold"
          style={{
            background: client.iconOverride.bg,
            color: client.iconOverride.fg,
            borderRadius: Math.round(size / 5),
            fontSize:
              client.iconOverride.glyph.length > 1 ? size * 0.27 : size * 0.42,
            letterSpacing: "-0.02em",
          }}
        >
          {client.iconOverride.glyph}
        </div>
      ) : (
        <Terminal className="size-1/2 text-foreground" strokeWidth={1.8} />
      )}
    </div>
  );
}
