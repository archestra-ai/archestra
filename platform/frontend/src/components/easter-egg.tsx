"use client";

import config from "@/lib/config";
import { useEasterEgg } from "@/lib/easter-egg.hook";
import { EasterEggDialog } from "./easter-egg-dialog";

export function EasterEgg() {
  const { isDialogOpen, closeDialog } = useEasterEgg(
    config.easterEgg.targetSequence || "",
  );

  // Only proceed if both target sequence and video URL are configured
  if (!config.easterEgg.targetSequence || !config.easterEgg.videoUrl) {
    return null;
  }

  return (
    <EasterEggDialog
      open={isDialogOpen}
      videoUrl={config.easterEgg.videoUrl}
      onOpenChange={(open) => {
        if (!open) {
          closeDialog();
        }
      }}
    />
  );
}
