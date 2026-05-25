import { regexDetector } from "./regex-detector";
import type { Detector, Finding } from "./types";

export type { Detector, DetectorContext, DetectorId, Finding } from "./types";
export { detectorId } from "./types";
export { regexDetector } from "./regex-detector";

export const defaultDetectors: Detector[] = [regexDetector];

export function scanText(text: string, detectors?: Detector[]): Finding[] {
  const active = detectors ?? defaultDetectors;
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const detector of active) {
    const produced = detector.scan(text, { existingFindings: findings });
    for (const finding of produced) {
      const key = `${finding.detectorId}:${finding.startIndex}:${finding.endIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(finding);
    }
  }

  return findings;
}
