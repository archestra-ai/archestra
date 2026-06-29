/**
 * MCP Orchestrator configuration and validation utilities.
 * Shared between backend (K8sDeployment) and frontend (form validation and placeholders).
 */

/**
 * Default values for MCP Orchestrator K8s deployment configuration.
 */
export const MCP_ORCHESTRATOR_DEFAULTS = {
  /** Default number of pod replicas */
  replicas: 1,
  /** Default memory request for containers */
  resourceRequestMemory: "128Mi",
  /** Default CPU request for containers */
  resourceRequestCpu: "50m",
} as const;

/**
 * Validates a Kubernetes memory resource quantity string.
 * Valid formats: "128Mi", "1Gi", "256M", "1G", "1024Ki", "1024", etc.
 * Supports decimal and binary suffixes as per K8s spec.
 *
 * @param value - The memory quantity string to validate
 * @returns true if valid, false otherwise
 */
export function isValidK8sMemoryQuantity(value: string): boolean {
  if (!value || !value.trim()) return false;
  // K8s memory format: number followed by optional suffix
  // Binary suffixes: Ki, Mi, Gi, Ti, Pi, Ei
  // Decimal suffixes: k, M, G, T, P, E (or K for kilo)
  // Or just a number (bytes)
  const memoryRegex = /^[0-9]+(\.[0-9]+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|K|M|G|T|P|E)?$/;
  return memoryRegex.test(value.trim());
}

/**
 * Validates a Kubernetes CPU resource quantity string.
 * Valid formats: "100m" (millicores), "0.5", "1", "1.5", "2000m", etc.
 *
 * @param value - The CPU quantity string to validate
 * @returns true if valid, false otherwise
 */
export function isValidK8sCpuQuantity(value: string): boolean {
  if (!value || !value.trim()) return false;
  // K8s CPU format: decimal number or integer followed by optional 'm' for millicores
  const cpuRegex = /^[0-9]+(\.[0-9]+)?m?$/;
  return cpuRegex.test(value.trim());
}

/**
 * Validates that a string is valid JSON containing only string key-value pairs.
 * Empty strings are allowed (treated as no value).
 *
 * @param value - The JSON string to validate
 * @returns true if valid (empty or valid JSON object with string values), false otherwise
 */
export function isValidJsonKeyValueString(value: string | undefined): boolean {
  if (!value || !value.trim()) return true; // Empty is valid
  try {
    const parsed = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return false;
    }
    // Check all values are strings
    return Object.values(parsed).every((v) => typeof v === "string");
  } catch {
    return false;
  }
}
