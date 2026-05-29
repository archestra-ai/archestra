import {
  type Detector,
  type DetectorContext,
  detectorId,
  type Finding,
} from "./types";

interface RegexRule {
  readonly internalLabel: string;
  readonly pattern: RegExp;
}

const RULES: readonly RegexRule[] = [
  { internalLabel: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/g },
  { internalLabel: "github-token", pattern: /gh[apousr]_[A-Za-z0-9]{36}/g },
  {
    internalLabel: "github-fine-grained-pat",
    pattern: /github_pat_[A-Za-z0-9_]{20,}/g,
  },
  { internalLabel: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    internalLabel: "openai-key",
    pattern: /(?<![A-Za-z0-9])sk-(?!ant-)[A-Za-z0-9_-]{20,}/g,
  },
  { internalLabel: "slack-token", pattern: /xox[abpr]-[A-Za-z0-9-]{10,}/g },
  { internalLabel: "google-api-key", pattern: /AIza[0-9A-Za-z\-_]{35}/g },
  {
    internalLabel: "jwt",
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  },
  {
    internalLabel: "pem-private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    internalLabel: "password-assignment",
    pattern: /\bpassword\s*[:=]\s*\S{4,}/gi,
  },
];

const REGEX_DETECTOR_ID = detectorId("regex");

export const regexDetector: Detector = {
  id: REGEX_DETECTOR_ID,
  scan(text: string, _context?: DetectorContext): Finding[] {
    const findings: Finding[] = [];
    const seenRanges = new Set<string>();

    for (const rule of RULES) {
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match = pattern.exec(text);
      while (match !== null) {
        if (match[0].length === 0) {
          pattern.lastIndex += 1;
          match = pattern.exec(text);
          continue;
        }
        const startIndex = match.index;
        const endIndex = startIndex + match[0].length;
        const key = `${startIndex}:${endIndex}`;
        if (!seenRanges.has(key)) {
          seenRanges.add(key);
          findings.push({
            detectorId: REGEX_DETECTOR_ID,
            internalLabel: rule.internalLabel,
            startIndex,
            endIndex,
          });
        }
        match = pattern.exec(text);
      }
    }

    return findings;
  },
};
