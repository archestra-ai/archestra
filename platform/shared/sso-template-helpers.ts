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
  return `${helperNames.slice(0, -1).join(", ")}, and ${helperNames.at(-1)}`;
}
