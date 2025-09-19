/**
 * Converts tool names from various formats (camelCase, snake_case, kebab-case, etc.)
 * to human-readable format with proper spacing and capitalization.
 */
export function formatToolName(name: string): string {
  if (!name) return '';

  return (
    name
      // Handle camelCase and PascalCase: insert space before uppercase letters
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      // Handle snake_case: replace underscores with spaces
      .replace(/_/g, ' ')
      // Handle kebab-case: replace hyphens with spaces
      .replace(/-/g, ' ')
      // Handle multiple consecutive spaces
      .replace(/\s+/g, ' ')
      // Trim and capitalize first letter of each word
      .trim()
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ')
  );
}
