/**
 * Error message factory utility
 * Provides standardized, actionable error messages with proper context
 * Reduces code duplication and ensures consistent error handling
 */

export interface ErrorContext {
  agentId?: string;
  toolName?: string;
  mcpServerName?: string;
  profileId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

/**
 * Standard error message templates
 */
export const ErrorTemplates = {
  UNKNOWN_ERROR: "Unknown error",
  INTERNAL_SERVER_ERROR: "Internal server error",
  TOOL_EXECUTION_FAILED: "Tool execution failed",
  TOOL_NOT_FOUND: "Tool not found or not assigned to agent",
  TOOL_NOT_FOUND_SPECIFIC: "Tool '{{toolName}}' not found or not assigned to agent '{{agentId}}'",
  MCP_SERVER_NOT_FOUND: "MCP server not found",
  EXECUTION_SOURCE_MISSING: "No execution source specified for MCP tool",
  EXECUTION_SOURCE_MISSING_DETAILED: `No execution source specified for MCP tool "{{toolName}}"
MCP Server: {{mcpServerName}}
Profile: {{profileId}}

To fix this issue:
1. Go to "MCP Registry" and verify that "{{mcpServerName}}" server is installed
2. Go to "Profiles" → Find the profile → Click the wrench icon
3. Ensure the tool "{{toolName}}" is assigned and the server is properly configured
4. If the server is not installed, install it from MCP Registry first

If the problem persists:
- Clear sessions: DELETE /api/v1/mcp/sessions with Authorization: Bearer {{agentId}}
- Reconnect your client to refresh the tool list`,
  INVALID_REQUEST: "Invalid request",
  UNAUTHORIZED: "Unauthorized",
  FORBIDDEN: "Forbidden",
  NOT_FOUND: "Resource not found",
  VALIDATION_ERROR: "Validation error",
  RATE_LIMIT_EXCEEDED: "Rate limit exceeded",
  SERVICE_UNAVAILABLE: "Service unavailable",
} as const;

/**
 * Error message factory class
 */
export class ErrorMessageFactory {
  /**
   * Creates a standardized error message from a template
   */
  static create(
    template: keyof typeof ErrorTemplates | string,
    context: ErrorContext = {},
  ): string {
    let message: string;

    if (typeof template === "string") {
      // If it's a string, check if it's a known template key
      const templateValue = ErrorTemplates[template as keyof typeof ErrorTemplates];
      if (templateValue) {
        message = templateValue;
      } else {
        // If not a known template, treat as literal message
        message = template;
      }
    } else {
      message = ErrorTemplates[template];
    }

    if (!message) {
      message = ErrorTemplates.UNKNOWN_ERROR;
    }

    // Replace template variables with context values
    return message.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      const value = context[key];
      return value !== undefined ? String(value) : match;
    });
  }

  /**
   * Creates an error message from an unknown error object
   */
  static fromError(error: unknown, fallback: string = ErrorTemplates.UNKNOWN_ERROR): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    return fallback;
  }

  /**
   * Creates a detailed tool execution error message
   */
  static toolExecutionError(
    toolName: string,
    context: ErrorContext,
    originalError?: unknown,
  ): string {
    const baseMessage = this.create("EXECUTION_SOURCE_MISSING_DETAILED", {
      toolName,
      ...context,
    });

    const errorDetails = originalError ? `\n\nOriginal error: ${this.fromError(originalError)}` : "";

    return baseMessage + errorDetails;
  }

  /**
   * Creates a tool not found error message
   */
  static toolNotFound(
    toolName: string,
    context: ErrorContext = {},
  ): string {
    return this.create("TOOL_NOT_FOUND_SPECIFIC", {
      toolName,
      ...context,
    });
  }

  /**
   * Creates a generic tool execution failed message with context
   */
  static toolExecutionFailed(
    context: ErrorContext = {},
    originalError?: unknown,
  ): string {
    const baseMessage = this.create("TOOL_EXECUTION_FAILED", context);
    const errorDetails = originalError ? `: ${this.fromError(originalError)}` : "";

    return baseMessage + errorDetails;
  }

  /**
   * Creates an internal server error message with context
   */
  static internalServerError(
    context: ErrorContext = {},
    originalError?: unknown,
  ): string {
    const baseMessage = this.create("INTERNAL_SERVER_ERROR", context);
    const errorDetails = originalError ? `: ${this.fromError(originalError)}` : "";

    return baseMessage + errorDetails;
  }

  /**
   * Creates a validation error message
   */
  static validationError(
    field: string,
    reason: string,
    context: ErrorContext = {},
  ): string {
    return this.create(`Validation error for ${field}: ${reason}`, context);
  }

  /**
   * Creates a not found error message
   */
  static notFound(
    resource: string,
    id?: string,
    context: ErrorContext = {},
  ): string {
    const identifier = id ? ` with ID ${id}` : "";
    return this.create(`${resource} not found${identifier}`, context);
  }
}



/**
 * Helper function for common error patterns
 */
export function safeErrorMessage(error: unknown, fallback?: string): string {
  return ErrorMessageFactory.fromError(error, fallback);
}