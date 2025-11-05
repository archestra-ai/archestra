/**
 * Converts JSON data to TOON (Token-Oriented Object Notation) format
 * for more efficient token usage in LLM contexts.
 *
 * TOON format is designed for uniform arrays of objects, declaring field names
 * once at the top and streaming data as rows without repeating keys.
 *
 * @see https://github.com/toon-format/toon
 */

/**
 * Check if a value is a plain object (not array, null, or other types)
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

/**
 * Check if an array contains uniform objects (all objects with same keys)
 */
function isUniformArray(arr: unknown[]): boolean {
  if (arr.length === 0) return false;

  // All elements must be plain objects
  if (!arr.every((item) => isPlainObject(item))) {
    return false;
  }

  // Get keys from first object
  const firstObj = arr[0] as Record<string, unknown>;
  const firstKeys = Object.keys(firstObj).sort();

  // All objects must have the same keys
  return arr.every((item) => {
    const itemKeys = Object.keys(item as Record<string, unknown>).sort();
    return (
      itemKeys.length === firstKeys.length &&
      itemKeys.every((key, i) => key === firstKeys[i])
    );
  });
}

/**
 * Escape a value for TOON format
 * - Strings with commas or newlines are wrapped in quotes
 * - Quotes inside strings are escaped
 */
function escapeToonValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const str = String(value);

  // If string contains comma, newline, or quote, wrap in quotes and escape quotes
  if (str.includes(",") || str.includes("\n") || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Convert a uniform array of objects to TOON format
 */
function arrayToToon(
  arr: Array<Record<string, unknown>>,
  arrayName: string,
  indent = "",
): string {
  if (arr.length === 0) {
    return `${indent}${arrayName}[0]{}:\n`;
  }

  // Get field names from first object
  const fields = Object.keys(arr[0]);

  // Array declaration: arrayName[count]{field1,field2,field3}:
  const header = `${indent}${arrayName}[${arr.length}]{${fields.join(",")}}:`;

  // Data rows
  const rows = arr.map((obj) => {
    const values = fields.map((field) => escapeToonValue(obj[field]));
    return `${indent} ${values.join(",")}`;
  });

  return [header, ...rows].join("\n");
}

/**
 * Convert any JSON value to TOON format recursively
 */
function valueToToon(value: unknown, indent = ""): string {
  // Handle primitives
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  // Handle arrays
  if (Array.isArray(value)) {
    // Check if it's a uniform array of objects
    if (isUniformArray(value)) {
      // This is a top-level uniform array, but we need a name
      // Return as anonymous array
      return arrayToToon(
        value as Array<Record<string, unknown>>,
        "items",
        indent,
      );
    }

    // Non-uniform array, fall back to JSON
    return JSON.stringify(value);
  }

  // Handle objects
  if (isPlainObject(value)) {
    const lines: string[] = [];

    for (const [key, val] of Object.entries(value)) {
      // Check if value is a uniform array
      if (Array.isArray(val) && isUniformArray(val)) {
        lines.push(
          arrayToToon(val as Array<Record<string, unknown>>, key, indent),
        );
      } else if (isPlainObject(val)) {
        // Nested object - convert recursively with indentation
        lines.push(`${indent}${key}:`);
        lines.push(valueToToon(val, indent + " "));
      } else {
        // Simple key-value pair
        lines.push(`${indent}${key}: ${valueToToon(val, "")}`);
      }
    }

    return lines.join("\n");
  }

  // Fallback to JSON for anything else
  return JSON.stringify(value);
}

/**
 * Convert JSON data to TOON format
 *
 * @param data - The JSON data to convert
 * @returns TOON formatted string
 *
 * @example
 * ```typescript
 * const data = {
 *   users: [
 *     { id: 1, name: "Alice", role: "admin" },
 *     { id: 2, name: "Bob", role: "user" }
 *   ]
 * };
 *
 * const toon = jsonToToon(data);
 * // Output:
 * // users[2]{id,name,role}:
 * //  1,Alice,admin
 * //  2,Bob,user
 * ```
 */
export function jsonToToon(data: unknown): string {
  // If data is already a string, return it
  if (typeof data === "string") {
    try {
      // Try to parse it as JSON first
      data = JSON.parse(data);
    } catch {
      // Not valid JSON, return as-is
      return data;
    }
  }

  // If it's a top-level uniform array, convert directly
  if (Array.isArray(data) && isUniformArray(data)) {
    return arrayToToon(data as Array<Record<string, unknown>>, "items");
  }

  // Otherwise convert the value
  const result = valueToToon(data);

  // If conversion failed or resulted in JSON, fall back to JSON
  if (result === JSON.stringify(data)) {
    return JSON.stringify(data, null, 2);
  }

  return result;
}

/**
 * Attempt to convert JSON to TOON, falling back to JSON if conversion is not beneficial
 *
 * @param data - The JSON data to convert
 * @returns TOON formatted string or JSON string if TOON is not beneficial
 */
export function convertToToonIfBeneficial(data: unknown): string {
  const toonResult = jsonToToon(data);
  const jsonResult = JSON.stringify(data);

  // Use TOON if it's shorter or same length
  // (In real scenarios TOON should be 30-60% shorter for uniform arrays)
  if (toonResult.length <= jsonResult.length) {
    return toonResult;
  }

  return jsonResult;
}
