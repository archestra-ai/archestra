"use client";

import dynamic from "next/dynamic";
import { useFeature } from "@/lib/config/config.query";

const DevFeedbackOverlay = dynamic(
  async () => (await import("./dev-feedback-overlay")).DevFeedbackOverlay,
  { ssr: false },
);

/**
 * Mounts the internal UI feedback overlay only on deployments that configure
 * its Slack channel, and only then loads its code.
 */
export function DevFeedbackLauncher() {
  const enabled = useFeature("devFeedbackEnabled");
  return enabled ? <DevFeedbackOverlay /> : null;
}
