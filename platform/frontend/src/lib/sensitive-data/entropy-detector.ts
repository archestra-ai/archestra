import {
  type Detector,
  type DetectorContext,
  detectorId,
  type Finding,
} from "./types";

const ENTROPY_DETECTOR_ID = detectorId("entropy");
const INTERNAL_LABEL = "high-entropy-token";

const CANDIDATE_PATTERN = /[A-Za-z0-9+/=_-]{20,}/g;
const HEX_ONLY_PATTERN = /^[0-9a-fA-F]+$/;

const BASE64_ENTROPY_THRESHOLD = 4.5;
const HEX_ENTROPY_THRESHOLD = 3.5;

export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }

  const len = s.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export const entropyDetector: Detector = {
  id: ENTROPY_DETECTOR_ID,
  scan(text: string, context?: DetectorContext): Finding[] {
    const findings: Finding[] = [];
    const existing = context?.existingFindings ?? [];

    const pattern = new RegExp(
      CANDIDATE_PATTERN.source,
      CANDIDATE_PATTERN.flags,
    );
    let match = pattern.exec(text);
    while (match !== null) {
      const token = match[0];
      if (token.length === 0) {
        pattern.lastIndex += 1;
        match = pattern.exec(text);
        continue;
      }
      const startIndex = match.index;
      const endIndex = startIndex + token.length;

      if (!overlapsExisting(startIndex, endIndex, existing)) {
        const threshold = HEX_ONLY_PATTERN.test(token)
          ? HEX_ENTROPY_THRESHOLD
          : BASE64_ENTROPY_THRESHOLD;

        if (shannonEntropy(token) >= threshold) {
          findings.push({
            detectorId: ENTROPY_DETECTOR_ID,
            internalLabel: INTERNAL_LABEL,
            startIndex,
            endIndex,
          });
        }
      }
      match = pattern.exec(text);
    }

    return findings;
  },
};

function overlapsExisting(
  start: number,
  end: number,
  existing: Finding[],
): boolean {
  for (const finding of existing) {
    if (start < finding.endIndex && end > finding.startIndex) return true;
  }
  return false;
}
