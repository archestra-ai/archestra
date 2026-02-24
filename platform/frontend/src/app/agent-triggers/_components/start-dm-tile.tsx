"use client";

import Image from "next/image";
import Divider from "@/components/divider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { ProviderConfig } from "./types";

interface StartDmTileProps {
  providerConfig: ProviderConfig;
  deepLink: string;
}

export function StartDmTile({ providerConfig, deepLink }: StartDmTileProps) {
  return (
    <Card className="h-full overflow-hidden border-dashed py-4">
      <CardContent className="flex h-full flex-col gap-3 px-4">
        <div className="flex items-center gap-2 min-w-0">
          <span className="bg-linear-to-r from-purple-600 to-blue-600 bg-clip-text text-base font-semibold text-transparent">
            Direct Message
          </span>
        </div>

        <div className="flex items-center gap-2 min-w-0 my-2 h-6">
          <span className="text-xs text-muted-foreground">
            Send your first direct message to the bot
          </span>
        </div>

        <Divider />

        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2 text-xs"
          asChild
        >
          <a href={deepLink} target="_blank" rel="noopener noreferrer">
            <Image
              src={providerConfig.providerIcon}
              alt={providerConfig.providerLabel}
              width={14}
              height={14}
            />
            Send DM
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}
