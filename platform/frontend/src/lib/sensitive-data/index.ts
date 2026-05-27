import { entropyDetector } from "./entropy-detector";
import { regexDetector } from "./regex-detector";
import type { Detector, Finding } from "./types";

export type { Detector, Finding } from "./types";

export const defaultDetectors: Detector[] = [regexDetector, entropyDetector];

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
