import { describe, expect, it } from "vitest";
import { ErrorMessageFactory, ErrorTemplates, safeErrorMessage } from "./error-messages";

describe("ErrorMessageFactory", () => {
  describe("create", () => {
    it("should return template message for known template", () => {
      const result = ErrorMessageFactory.create("TOOL_EXECUTION_FAILED");
      expect(result).toBe("Tool execution failed");
    });

    it("should replace template variables with context", () => {
      const result = ErrorMessageFactory.create("TOOL_NOT_FOUND_SPECIFIC", {
        toolName: "test-tool",
        agentId: "agent-123",
      });
      expect(result).toContain("Tool 'test-tool' not found");
      expect(result).toContain("agent 'agent-123'");
    });

    it("should return custom message when template is string", () => {
      const result = ErrorMessageFactory.create("Custom error message");
      expect(result).toBe("Custom error message");
    });

    it("should return literal message for unknown template key", () => {
      const result = ErrorMessageFactory.create("INVALID_TEMPLATE" as any);
      expect(result).toBe("INVALID_TEMPLATE");
    });
  });

  describe("fromError", () => {
    it("should return error message for Error instance", () => {
      const error = new Error("Test error");
      const result = ErrorMessageFactory.fromError(error);
      expect(result).toBe("Test error");
    });

    it("should return string error as-is", () => {
      const result = ErrorMessageFactory.fromError("String error");
      expect(result).toBe("String error");
    });

    it("should return fallback for unknown error type", () => {
      const result = ErrorMessageFactory.fromError(null);
      expect(result).toBe("Unknown error");
    });

    it("should use custom fallback", () => {
      const result = ErrorMessageFactory.fromError(null, "Custom fallback");
      expect(result).toBe("Custom fallback");
    });
  });

  describe("toolExecutionError", () => {
    it("should create detailed tool execution error message", () => {
      const result = ErrorMessageFactory.toolExecutionError("test-tool", {
        agentId: "agent-123",
        mcpServerName: "test-server",
        profileId: "profile-456",
      });

      expect(result).toContain("No execution source specified for MCP tool \"test-tool\"");
      expect(result).toContain("MCP Server: test-server");
      expect(result).toContain("Profile: profile-456");
      expect(result).toContain("To fix this issue:");
      expect(result).toContain("Clear sessions");
    });

    it("should include original error when provided", () => {
      const result = ErrorMessageFactory.toolExecutionError("test-tool", {}, new Error("Original error"));
      expect(result).toContain("Original error: Original error");
    });
  });

  describe("toolNotFound", () => {
    it("should create tool not found message", () => {
      const result = ErrorMessageFactory.toolNotFound("test-tool", { agentId: "agent-123" });
      expect(result).toContain("Tool 'test-tool' not found");
      expect(result).toContain("agent 'agent-123'");
    });
  });

  describe("toolExecutionFailed", () => {
    it("should create tool execution failed message", () => {
      const result = ErrorMessageFactory.toolExecutionFailed();
      expect(result).toBe("Tool execution failed");
    });

    it("should include original error", () => {
      const result = ErrorMessageFactory.toolExecutionFailed({}, "Connection failed");
      expect(result).toBe("Tool execution failed: Connection failed");
    });
  });

  describe("internalServerError", () => {
    it("should create internal server error message", () => {
      const result = ErrorMessageFactory.internalServerError();
      expect(result).toBe("Internal server error");
    });

    it("should include original error", () => {
      const result = ErrorMessageFactory.internalServerError({}, new Error("Database connection failed"));
      expect(result).toBe("Internal server error: Database connection failed");
    });
  });

  describe("validationError", () => {
    it("should create validation error message", () => {
      const result = ErrorMessageFactory.validationError("email", "Invalid format");
      expect(result).toBe("Validation error for email: Invalid format");
    });
  });

  describe("notFound", () => {
    it("should create not found message without ID", () => {
      const result = ErrorMessageFactory.notFound("User");
      expect(result).toBe("User not found");
    });

    it("should create not found message with ID", () => {
      const result = ErrorMessageFactory.notFound("User", "123");
      expect(result).toBe("User not found with ID 123");
    });
  });
});

describe("safeErrorMessage", () => {
  it("should delegate to ErrorMessageFactory.fromError", () => {
    const error = new Error("Test error");
    const result = safeErrorMessage(error);
    expect(result).toBe("Test error");
  });

  it("should use custom fallback", () => {
    const result = safeErrorMessage(null, "Custom fallback");
    expect(result).toBe("Custom fallback");
  });
});

describe("ErrorTemplates", () => {
  it("should contain all expected templates", () => {
    expect(ErrorTemplates.UNKNOWN_ERROR).toBe("Unknown error");
    expect(ErrorTemplates.INTERNAL_SERVER_ERROR).toBe("Internal server error");
    expect(ErrorTemplates.TOOL_EXECUTION_FAILED).toBe("Tool execution failed");
    expect(ErrorTemplates.EXECUTION_SOURCE_MISSING).toBe("No execution source specified for MCP tool");
  });
});