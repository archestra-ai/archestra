"use client";

import { Terminal } from "lucide-react";
import { ClientMarkTile, markTileRadius } from "@/components/client-mark-tile";
import type { ConnectClient } from "./clients";

interface ClientIconProps {
  client: ConnectClient;
  size?: number;
}

export function ClientIcon({ client, size = 36 }: ClientIconProps) {
  if (client.svg) {
    return (
      <ClientMarkTile
        mark={{
          viewBox: client.svgViewBox ?? "0 0 24 24",
          path: client.svg,
          fillRule: client.svgFillRule,
          accent: client.svgAccent,
          color: client.iconColor || "currentColor",
          background: client.tileBg || "var(--muted)",
        }}
        label={client.label}
        size={size}
      />
    );
  }
  const radius = markTileRadius(size);
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
      {client.iconOverride ? (
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
