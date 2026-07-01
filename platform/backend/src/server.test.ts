import { vi } from "vitest";
import { z } from "zod";
import { describe, expect, test } from "@/test";
import { ApiError } from "@/types";

// Create a hoisted mock function that defaults to returning true (healthy)
const mockIsDatabaseHealthy = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockSentryCaptureException = vi.hoisted(() => vi.fn());

// Mock the database module before any imports that depend on it
vi.mock("@/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/database")>();
  return {
    ...actual,
    isDatabaseHealthy: mockIsDatabaseHealthy,
  };
});

vi.mock("@sentry/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/node")>();
  return {
    ...actual,
    captureException: mockSentryCaptureException,
  };
});

import config from "@/config";
// Import after mock setup
import healthRoutes from "@/routes/health";
import { createFastifyInstance } from "./server";

// Mock process.exit to prevent it from actually exiting during tests
const _processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
  // Don't actually exit or throw, just mock it
  return undefined as never;
});

describe("createFastifyInstance", () => {
  describe("error handling", () => {
    test.each([
      [400, "Validation failed", "api_validation_error"],
      [401, "Unauthenticated", "api_authentication_error"],
      [403, "Forbidden", "api_authorization_error"],
      [404, "Not found", "api_not_found_error"],
      [500, "Internal server error", "api_internal_server_error"],
      [409, "Resource conflict", "api_conflict_error"],
      [418, "I'm a teapot", "unknown_api_error"],
    ])("maps ApiError %i to its error type", async (statusCode, message, type) => {
      const app = createFastifyInstance();

      app.get(`/test-${statusCode}`, async () => {
        throw new ApiError(statusCode, message);
      });

      const response = await app.inject({
        method: "GET",
        url: `/test-${statusCode}`,
      });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual({
        error: { message, type },
      });
    });

    test("handles standard Error objects correctly", async () => {
      const app = createFastifyInstance();

      app.get("/test-standard-error", async () => {
        throw new Error("Something went wrong");
      });

      const response = await app.inject({
        method: "GET",
        url: "/test-standard-error",
      });

      // Standard errors are now properly handled as 500 with api_internal_server_error type
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: {
          message: "Something went wrong",
          type: "api_internal_server_error",
        },
      });
    });

    test("handles TypeError objects correctly", async () => {
      const app = createFastifyInstance();

      app.get("/test-type-error", async () => {
        throw new TypeError("Cannot read property of undefined");
      });

      const response = await app.inject({
        method: "GET",
        url: "/test-type-error",
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: {
          message: "Cannot read property of undefined",
          type: "api_internal_server_error",
        },
      });
    });

    test("handles response serialization errors when response doesn't match schema", async () => {
      const app = createFastifyInstance();

      app.get(
        "/test-serialization-error",
        {
          schema: {
            response: {
              200: z.object({
                name: z.string(),
                count: z.number(),
              }),
            },
          },
        },
        async () => {
          // Return data that doesn't match the response schema (wrong type for "count")
          return { name: "test", count: "not-a-number" };
        },
      );

      const response = await app.inject({
        method: "GET",
        url: "/test-serialization-error",
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: {
          message: "Response doesn't match the schema",
          type: "api_internal_server_error",
        },
      });
    });

    test("captures response serialization errors in Sentry with validation details", async () => {
      mockSentryCaptureException.mockClear();
      const app = createFastifyInstance();

      app.get(
        "/test-serialization-sentry",
        {
          schema: {
            response: {
              200: z.object({
                id: z.string(),
                active: z.boolean(),
              }),
            },
          },
        },
        async () => {
          // Return wrong type for "active" to trigger serialization error
          return { id: "123", active: "yes" };
        },
      );

      await app.inject({
        method: "GET",
        url: "/test-serialization-sentry",
      });

      // Verify Sentry.captureException was called with the error and validation details
      expect(mockSentryCaptureException).toHaveBeenCalledTimes(1);

      const [capturedError, capturedContext] =
        mockSentryCaptureException.mock.calls[0];
      expect(capturedError).toBeDefined();
      expect(capturedContext.extra).toBeDefined();
      expect(capturedContext.extra.method).toBe("GET");
      expect(capturedContext.extra.url).toContain("/test-serialization-sentry");
      expect(capturedContext.extra.validationErrors).toBeInstanceOf(Array);
      expect(capturedContext.extra.validationErrors.length).toBeGreaterThan(0);
      expect(capturedContext.tags).toEqual({
        error_type: "response_serialization",
      });

      // Verify the validation error has useful details
      const firstError = capturedContext.extra.validationErrors[0];
      expect(firstError).toHaveProperty("path");
      expect(firstError).toHaveProperty("code");
      expect(firstError).toHaveProperty("message");
    });

    test("logs response serialization errors with validation details in message", async () => {
      const app = createFastifyInstance();
      const loggerErrorSpy = vi.spyOn(app.log, "error");

      app.get(
        "/test-serialization-logging",
        {
          schema: {
            response: {
              200: z.object({
                value: z.number(),
              }),
            },
          },
        },
        async () => {
          return { value: "not-a-number" };
        },
      );

      await app.inject({
        method: "GET",
        url: "/test-serialization-logging",
      });

      // Verify the log message includes the URL and validation error details
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 500,
          method: "GET",
          validationErrors: expect.arrayContaining([
            expect.objectContaining({
              code: expect.any(String),
              message: expect.any(String),
            }),
          ]),
        }),
        expect.stringContaining("/test-serialization-logging"),
      );

      loggerErrorSpy.mockRestore();
    });

    test("handles validation errors from Zod", async () => {
      const app = createFastifyInstance();

      const TestSchema = z.object({
        required: z.string(),
      });

      app.post(
        "/test-validation",
        {
          schema: {
            body: TestSchema,
            response: {
              200: z.object({ success: z.boolean() }),
            },
          },
        },
        async () => {
          return { success: true };
        },
      );

      const response = await app.inject({
        method: "POST",
        url: "/test-validation",
        headers: {
          "content-type": "application/json",
        },
        payload: {
          // Missing required field
          notRequired: "value",
        },
      });

      // Zod validation errors are handled properly and return 400
      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBeDefined();
      expect(body.error.type).toBe("api_validation_error");
      expect(typeof body.error.message).toBe("string");
    });

    test("returns 413 with body-too-large message when payload exceeds limit", async () => {
      const app = createFastifyInstance();
      const loggerWarnSpy = vi.spyOn(app.log, "warn");

      // Route-scoped bodyLimit keeps the test payload small while still
      // exercising the FST_ERR_CTP_BODY_TOO_LARGE branch.
      app.post("/test-413", { bodyLimit: 100 }, async () => ({ ok: true }));

      const oversized = "x".repeat(500);
      const response = await app.inject({
        method: "POST",
        url: "/test-413",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ data: oversized }),
      });

      expect(response.statusCode).toBe(413);
      const body = response.json();
      expect(body.error.type).toBe("api_payload_too_large_error");
      expect(body.error.message).toMatch(/Request body too large/);
      expect(body.error.message).toMatch(/ARCHESTRA_API_BODY_LIMIT/);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 413,
          code: "FST_ERR_CTP_BODY_TOO_LARGE",
          bodyLimit: expect.any(Number),
          method: "POST",
          url: "/test-413",
        }),
        "HTTP 413 request body too large",
      );

      loggerWarnSpy.mockRestore();
    });
  });

  describe("logging verification", () => {
    test("logs 500+ errors at error level", async () => {
      const app = createFastifyInstance();

      // Mock the logger error method
      const loggerErrorSpy = vi.spyOn(app.log, "error");

      app.get("/test-500-logging", async () => {
        throw new ApiError(500, "Server error");
      });

      await app.inject({
        method: "GET",
        url: "/test-500-logging",
      });

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Server error",
          statusCode: 500,
          method: "GET",
          url: "/test-500-logging",
        }),
        "HTTP 50x request error occurred",
      );

      loggerErrorSpy.mockRestore();
    });

    test("logs 400-499 errors at info level", async () => {
      const app = createFastifyInstance();

      // Mock the logger info method
      const loggerInfoSpy = vi.spyOn(app.log, "info");

      app.get("/test-400-logging", async () => {
        throw new ApiError(404, "Not found");
      });

      await app.inject({
        method: "GET",
        url: "/test-400-logging",
      });

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Not found",
          statusCode: 404,
          method: "GET",
          url: "/test-400-logging",
        }),
        "HTTP 40x request error occurred",
      );

      loggerInfoSpy.mockRestore();
    });

    test("logs unknown 4xx status codes at info level", async () => {
      const app = createFastifyInstance();

      // Mock the logger info method since 418 >= 400
      const loggerInfoSpy = vi.spyOn(app.log, "info");

      app.get("/test-unknown-logging", async () => {
        throw new ApiError(418, "I'm a teapot");
      });

      await app.inject({
        method: "GET",
        url: "/test-unknown-logging",
      });

      // Verify that info level logging was called for 4xx status codes
      expect(loggerInfoSpy).toHaveBeenCalled();

      loggerInfoSpy.mockRestore();
    });

    test("logs unknown status codes below 400 at error level", async () => {
      const app = createFastifyInstance();

      // Mock the logger error method
      const loggerErrorSpy = vi.spyOn(app.log, "error");

      app.get("/test-low-status-logging", async () => {
        throw new ApiError(200, "Success with error"); // Unusual but tests the else branch
      });

      await app.inject({
        method: "GET",
        url: "/test-low-status-logging",
      });

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Success with error",
          statusCode: 200,
          method: "GET",
          url: "/test-low-status-logging",
        }),
        "HTTP request error occurred",
      );

      loggerErrorSpy.mockRestore();
    });

    test("logs standard errors at error level with request context", async () => {
      const app = createFastifyInstance();

      const loggerErrorSpy = vi.spyOn(app.log, "error");

      app.get("/test-standard-error-logging", async () => {
        throw new Error("Standard error");
      });

      await app.inject({
        method: "GET",
        url: "/test-standard-error-logging",
      });

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Standard error",
          statusCode: 500,
          method: "GET",
          url: "/test-standard-error-logging",
          stack: expect.any(String),
        }),
        "HTTP 50x request error occurred",
      );

      loggerErrorSpy.mockRestore();
    });
  });

  describe("response format", () => {
    test("returns consistent error response format for ApiError", async () => {
      const app = createFastifyInstance();

      app.get("/test-format", async () => {
        throw new ApiError(422, "Unprocessable entity");
      });

      const response = await app.inject({
        method: "GET",
        url: "/test-format",
      });

      expect(response.statusCode).toBe(422);

      const body = response.json();
      expect(body).toHaveProperty("error");
      expect(body.error).toHaveProperty("message");
      expect(body.error).toHaveProperty("type");
      expect(body.error.message).toBe("Unprocessable entity");
      expect(body.error.type).toBe("unknown_api_error");
    });

    test("handles errors thrown from async route handlers", async () => {
      const app = createFastifyInstance();

      app.get("/test-async-error", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        throw new ApiError(409, "Conflict");
      });

      const response = await app.inject({
        method: "GET",
        url: "/test-async-error",
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: {
          message: "Conflict",
          type: "api_conflict_error",
        },
      });
    });

    test("handles errors with different HTTP methods", async () => {
      const app = createFastifyInstance();

      const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

      for (const method of methods) {
        app.route({
          method,
          url: `/test-${method.toLowerCase()}`,
          handler: async () => {
            throw new ApiError(400, `${method} validation error`);
          },
        });
      }

      for (const method of methods) {
        const response = await app.inject({
          method,
          url: `/test-${method.toLowerCase()}`,
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          error: {
            message: `${method} validation error`,
            type: "api_validation_error",
          },
        });
      }
    });
  });

  describe("Fastify instance configuration", () => {
    test("has ZodTypeProvider configured", async () => {
      const app = createFastifyInstance();

      const TestSchema = z.object({
        name: z.string(),
        age: z.number(),
      });

      app.post(
        "/test-zod",
        {
          schema: {
            body: TestSchema,
            response: {
              200: z.object({ received: z.boolean() }),
            },
          },
        },
        async (request) => {
          // If Zod validation works, request.body should be typed correctly
          expect((request.body as { name: string }).name).toBeDefined();
          expect((request.body as { age: number }).age).toBeDefined();
          return { received: true };
        },
      );

      const response = await app.inject({
        method: "POST",
        url: "/test-zod",
        headers: {
          "content-type": "application/json",
        },
        payload: {
          name: "John",
          age: 30,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ received: true });
    });

    test("has validator and serializer compilers configured", async () => {
      const app = createFastifyInstance();

      // Test that the compilers are working by using a route with schema validation
      app.get(
        "/test-compilers",
        {
          schema: {
            querystring: z.object({
              test: z.string(),
            }),
            response: {
              200: z.object({
                message: z.string(),
                query: z.string(),
              }),
            },
          },
        },
        async (request) => {
          return {
            message: "Compilers working",
            query: (request.query as { test: string }).test,
          };
        },
      );

      const response = await app.inject({
        method: "GET",
        url: "/test-compilers?test=value",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        message: "Compilers working",
        query: "value",
      });
    });
  });
});

describe("health endpoints", () => {
  describe("/health endpoint", () => {
    test("returns 200 with application info", async () => {
      const app = createFastifyInstance();
      await app.register(healthRoutes);

      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty("name");
      expect(body).toHaveProperty("status");
      expect(body).toHaveProperty("version");
      expect(body.status).toBe("ok");
    });
  });

  describe("/ready endpoint", () => {
    test("returns 200 when database is healthy", async () => {
      const app = createFastifyInstance();
      await app.register(healthRoutes);

      const response = await app.inject({
        method: "GET",
        url: "/ready",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty("name");
      expect(body).toHaveProperty("status");
      expect(body).toHaveProperty("version");
      expect(body).toHaveProperty("database");
      expect(body.status).toBe("ok");
      expect(body.database).toBe("connected");
    });

    test("returns 503 when database is unhealthy", async () => {
      const app = createFastifyInstance();
      await app.register(healthRoutes);

      // Mock isDatabaseHealthy to return false
      mockIsDatabaseHealthy.mockResolvedValueOnce(false);

      const response = await app.inject({
        method: "GET",
        url: "/ready",
      });

      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.status).toBe("degraded");
      expect(body.database).toBe("disconnected");
    });

    test("returns 200 without checking the database in maintenance mode", async () => {
      const originalMaintenanceMode = config.maintenanceMode;
      config.maintenanceMode = "Scheduled maintenance";
      mockIsDatabaseHealthy.mockClear();

      try {
        const app = createFastifyInstance();
        await app.register(healthRoutes);

        const response = await app.inject({
          method: "GET",
          url: "/ready",
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          status: "maintenance",
          database: "not_checked",
        });
        expect(mockIsDatabaseHealthy).not.toHaveBeenCalled();
      } finally {
        config.maintenanceMode = originalMaintenanceMode;
      }
    });
  });
});
