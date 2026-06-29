export const SSO_TEMPLATE_HELPER_NAMES = [
  "includes",
  "equals",
  "notEquals",
  "contains",
  "and",
  "or",
  "exists",
  "json",
  "pluck",
] as const;

export const SSO_TEMPLATE_HELPER_LIST_LABEL = formatTemplateHelperNames(
  SSO_TEMPLATE_HELPER_NAMES,
);

export const SSO_GROUP_CLAIM_NAMES = [
  "groups",
  "group",
  "memberOf",
  "member_of",
  "roles",
  "role",
  "teams",
  "team",
] as const;

type TemplateHelperOptions = {
  fn: (context?: unknown) => unknown;
  inverse: (context?: unknown) => unknown;
};

type TemplateHelper = (this: unknown, ...args: unknown[]) => unknown;

type TemplateHelperRegistry = {
  registerHelper: (name: string, helper: TemplateHelper) => void;
};

export function registerSsoTemplateHelpers(registry: TemplateHelperRegistry) {
  registry.registerHelper("json", jsonHelper);
  registry.registerHelper("includes", includesHelper);
  registry.registerHelper("contains", containsHelper);
  registry.registerHelper("equals", equalsHelper);
  registry.registerHelper("notEquals", notEqualsHelper);
  registry.registerHelper("and", andHelper);
  registry.registerHelper("or", orHelper);
  registry.registerHelper("exists", existsHelper);
  registry.registerHelper("pluck", pluckHelper);
}

export function isTruthyTemplateOutput(output: string): boolean {
  const normalizedOutput = output.trim();
  return (
    normalizedOutput.length > 0 &&
    normalizedOutput !== "false" &&
    normalizedOutput !== "0"
  );
}

export function extractSsoGroupsFromClaims(
  claims: Record<string, unknown>,
): string[] {
  for (const claimName of SSO_GROUP_CLAIM_NAMES) {
    const groups = normalizeSsoClaimGroups(claims[claimName], false);
    if (groups.length > 0) return groups;
  }

  return [];
}

export function extractSsoGroupsFromRenderedTemplate(output: string): string[] {
  if (!output) return [];

  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim());
    }
  } catch {
    // Not JSON; treat as comma-separated template output.
  }

  return output
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeSsoClaimGroups(
  value: unknown,
  valueCameFromArray: boolean,
): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => normalizeSsoClaimGroups(item, true))
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (typeof value === "string" && value.trim()) {
    if (valueCameFromArray) {
      return [value.trim()];
    }
    if (value.includes(",")) {
      return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    if (value.includes(" ")) {
      return value
        .split(" ")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return [value.trim()];
  }

  return [];
}

function jsonHelper(context: unknown) {
  if (typeof context === "string") {
    try {
      return JSON.parse(context);
    } catch {
      return context;
    }
  }
  return JSON.stringify(context);
}

function includesHelper(this: unknown, ...args: unknown[]) {
  const [array, value, options] = args as [
    unknown,
    unknown,
    TemplateHelperOptions,
  ];
  if (!Array.isArray(array)) return options.inverse(this);
  const found = array.some((item) => {
    if (typeof item === "string" && typeof value === "string") {
      return item.toLowerCase() === value.toLowerCase();
    }
    return item === value;
  });
  return found ? options.fn(this) : options.inverse(this);
}

function containsHelper(this: unknown, ...args: unknown[]) {
  const [str, substring, options] = args as [
    unknown,
    unknown,
    TemplateHelperOptions,
  ];
  if (typeof str !== "string" || typeof substring !== "string") {
    return options.inverse(this);
  }
  return str.toLowerCase().includes(substring.toLowerCase())
    ? options.fn(this)
    : options.inverse(this);
}

function equalsHelper(this: unknown, ...args: unknown[]) {
  const [a, b, options] = args as [unknown, unknown, TemplateHelperOptions];
  if (typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() === b.toLowerCase()
      ? options.fn(this)
      : options.inverse(this);
  }
  return a === b ? options.fn(this) : options.inverse(this);
}

function notEqualsHelper(this: unknown, ...args: unknown[]) {
  const [a, b, options] = args as [unknown, unknown, TemplateHelperOptions];
  if (typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() !== b.toLowerCase()
      ? options.fn(this)
      : options.inverse(this);
  }
  return a !== b ? options.fn(this) : options.inverse(this);
}

function andHelper(this: unknown, ...args: unknown[]) {
  const options = args.pop() as TemplateHelperOptions;
  return args.every(Boolean) ? options.fn(this) : options.inverse(this);
}

function orHelper(this: unknown, ...args: unknown[]) {
  const options = args.pop() as TemplateHelperOptions;
  return args.some(Boolean) ? options.fn(this) : options.inverse(this);
}

function existsHelper(this: unknown, ...args: unknown[]) {
  const [value, options] = args as [unknown, TemplateHelperOptions];
  return value !== null && value !== undefined
    ? options.fn(this)
    : options.inverse(this);
}

function pluckHelper(array: unknown, property: unknown) {
  if (!Array.isArray(array)) return [];
  return array
    .map((item) =>
      typeof item === "object" && item
        ? (item as Record<string, unknown>)[String(property)]
        : null,
    )
    .filter((value) => value !== null && value !== undefined);
}

function formatTemplateHelperNames(helperNames: readonly string[]) {
  if (helperNames.length <= 1) return helperNames.join("");
  return `${helperNames.slice(0, -1).join(", ")}, and ${
    helperNames[helperNames.length - 1]
  }`;
}
