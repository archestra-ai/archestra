import type { MemoryPolicyFlag } from "@/types/memory-item";
import { classifyInstructionLike } from "./instruction-classifier";

export type SensitiveDataBlockReason =
  | "secret"
  | "high_risk_pii"
  | "instruction_like_high";

export type SensitiveDataDecision = "allow" | "flag" | "block";

export type SensitiveDataReason =
  | "none"
  | "secret"
  | "high_risk_pii"
  | "instruction_like_high"
  | "instruction_like_medium";

export type SensitiveDataScreenResult = {
  decision: SensitiveDataDecision;
  severity: "low" | "medium" | "high";
  reason: SensitiveDataReason;
  blocked: boolean;
  blockReason: SensitiveDataBlockReason | null;
  policyFlags: MemoryPolicyFlag[];
  matchedDetectors: string[];
  secretDetected: boolean;
  piiCategories: string[];
};

export function screenSensitiveData(params: {
  content: string;
}): SensitiveDataScreenResult {
  const normalizedContent = params.content.trim();
  const secretMatches = findRegexMatches(normalizedContent, SECRET_DETECTORS);

  if (secretMatches.length > 0) {
    return {
      decision: "block",
      severity: "high",
      reason: "secret",
      blocked: true,
      blockReason: "secret",
      policyFlags: [],
      matchedDetectors: toSortedUniqueList(secretMatches),
      secretDetected: true,
      piiCategories: [],
    };
  }

  const piiMatches = findRegexMatches(
    normalizedContent,
    HIGH_RISK_PII_DETECTORS,
  );
  if (containsCreditCard(normalizedContent)) {
    piiMatches.push("credit_card");
  }

  if (piiMatches.length > 0) {
    return {
      decision: "block",
      severity: "high",
      reason: "high_risk_pii",
      blocked: true,
      blockReason: "high_risk_pii",
      policyFlags: [],
      matchedDetectors: toSortedUniqueList(piiMatches),
      secretDetected: false,
      piiCategories: mapDetectorsToPiiCategories(piiMatches),
    };
  }

  const instructionClassification = classifyInstructionLike(normalizedContent);
  if (instructionClassification?.severity === "high") {
    return {
      decision: "block",
      severity: "high",
      reason: "instruction_like_high",
      blocked: true,
      blockReason: "instruction_like_high",
      policyFlags: [],
      matchedDetectors: toSortedUniqueList(instructionClassification.detectors),
      secretDetected: false,
      piiCategories: [],
    };
  }

  if (instructionClassification?.severity === "medium") {
    return {
      decision: "flag",
      severity: "medium",
      reason: "instruction_like_medium",
      blocked: false,
      blockReason: null,
      policyFlags: ["instruction_like", "instruction_like_medium"],
      matchedDetectors: toSortedUniqueList(instructionClassification.detectors),
      secretDetected: false,
      piiCategories: [],
    };
  }

  return {
    decision: "allow",
    severity: "low",
    reason: "none",
    blocked: false,
    blockReason: null,
    policyFlags: [],
    matchedDetectors: [],
    secretDetected: false,
    piiCategories: [],
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

type RegexDetector = {
  id: string;
  regex: RegExp;
};

function findRegexMatches(
  content: string,
  detectors: readonly RegexDetector[],
): string[] {
  const matches: string[] = [];

  for (const detector of detectors) {
    detector.regex.lastIndex = 0;
    if (detector.regex.test(content)) {
      matches.push(detector.id);
    }
  }

  return matches;
}

function containsCreditCard(content: string): boolean {
  const matches = content.match(/(?:\d[ -]*?){13,19}/g);
  if (!matches) {
    return false;
  }

  for (const candidate of matches) {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) {
      continue;
    }

    if (passesLuhnCheck(digits)) {
      return true;
    }
  }

  return false;
}

function passesLuhnCheck(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number.parseInt(digits[index] ?? "", 10);
    if (!Number.isFinite(value)) {
      return false;
    }

    if (shouldDouble) {
      value *= 2;
      if (value > 9) {
        value -= 9;
      }
    }

    sum += value;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

function toSortedUniqueList(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right),
  );
}

const DETECTOR_TO_PII_CATEGORY: Record<string, string> = {
  ssn_like: "ssn",
  ssn_keyword: "ssn",
  government_id_keyword: "government_id",
  financial_account_keyword: "financial_account",
  financial_sensitive_keyword: "financial",
  minors_keyword: "minors",
  health_sensitive_keyword: "health",
  legal_sensitive_keyword: "legal",
  credit_card: "credit_card",
};

function mapDetectorsToPiiCategories(detectors: string[]): string[] {
  const categories = new Set<string>();
  for (const detector of detectors) {
    const category = DETECTOR_TO_PII_CATEGORY[detector];
    if (category) {
      categories.add(category);
    }
  }
  return Array.from(categories).sort();
}

const SECRET_DETECTORS: readonly RegexDetector[] = [
  {
    id: "aws_access_key",
    regex: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: "openai_key",
    regex: /\bsk-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: "github_token",
    regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i,
  },
  {
    id: "google_api_key",
    regex: /\bAIza[0-9A-Za-z\-_]{35}\b/,
  },
  {
    id: "jwt_like_token",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
  {
    id: "password_assignment",
    regex: /\b(password|secret|token|api[_\s-]?key)\b\s*[:=]\s*\S+/i,
  },
  {
    id: "natural_language_password",
    regex: /\b(my|the)\s+password\s+is\b/i,
  },
  {
    id: "natural_language_api_key",
    regex: /\b(the|my)\s+api[_\s-]?key\s+is\b/i,
  },
  {
    id: "natural_language_secret_assignment",
    regex: /\bsecret\s+(is|equals?)\b/i,
  },
];

const HIGH_RISK_PII_DETECTORS: readonly RegexDetector[] = [
  {
    id: "ssn_like",
    regex: /\b\d{3}-\d{2}-\d{4}\b/,
  },
  {
    id: "government_id_keyword",
    regex:
      /\b(passport|driver(?:'s)?\s+license|national\s+id|government\s+id)\b/i,
  },
  {
    id: "financial_account_keyword",
    regex: /\b(bank\s+account|routing\s+number|iban|swift)\b/i,
  },
  {
    id: "minors_keyword",
    regex: /\b(minor|underage|child|kid)\b/i,
  },
  {
    id: "health_sensitive_keyword",
    regex:
      /\b(diagnosis|medical\s+record|prescription|therapy|hiv|cancer|pregnancy|depression|anxiety|adhd|autism|addiction|mental\s+health)\b/i,
  },
  {
    id: "ssn_keyword",
    regex: /\b(ssn|social\s+security\s+number)\b/i,
  },
  {
    id: "financial_sensitive_keyword",
    regex:
      /\b(credit\s+card|card\s+number|debit\s+card|cvv|cvc|routing\s+number|bank\s+account)\b/i,
  },
  {
    id: "legal_sensitive_keyword",
    regex: /\b(attorney-client|legal\s+dispute|lawsuit)\b/i,
  },
];
