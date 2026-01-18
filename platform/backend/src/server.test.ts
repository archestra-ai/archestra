import { vi } from "vitest";
import { z } from "zod";
import { describe, expect, test } from "@/test";
import { ApiError } from "@/types";

// Create a hoisted mock function that defaults to returning true (healthy)
const mockIsDatabaseHealthy = vi.hoisted(() => vi.fn().mockResolvedValue(true));

// Mock the database module before any imports that depend on it
vi.mock("@/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/database")>();
  return {
    ...actual,
    isDatabaseHealthy: mockIsDatabaseHealthy,
  };
});

// Import after mock setup
import { isDatabaseHealthy } from "@/database";
import {
  createFastifyInstance,
  registerHealthEndpoint,
  registerReadinessEndpoint,
} from "./server";

// Mock process.exit to prevent it from actually exiting during tests
const _processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
  // Don't actually exit or throw, just mock it
  return undefined as never;
});

describe("createFastifyInstance", () => {
  describe("error handling", () => {
    test("handles ApiError with 400 status code", async () => {
      const app = createFastifyInstance();

      app.get("/test-400", async () => {
        throw new ApiError(400, "Validation failed");
      });

      const response = await app.inject({
        method: "GET",
        url: "/test-400",
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          message: "Validation failed",
          type: "api_validation_error",
        },
      });
    });

    test("handles ApiError with 401 status code", async () => {
      const app = createFastifyInstance();

      app.get("/test-401", async () => {
        throw new ApiError(401, "Unauthenticated");
      });

      const response = await app.inject({
        method: "GET",
        url: "/test-401",
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: {
          message: "Unauthenticated",
          type: "api_authentication_error",
        },
      });
    });

    test("handles ApiError with 403 status code", async () => {
      const app = createFastifyInstance();

      app.get("/test-403", async () => {
        throw new ApiError(403, "Forbidden");
      });

      const response = await app.inject({
        method: "GET",
        url: "/test-403",
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: {
          message: "Forbidden",
          type: "api_authorization_error",
        },
      });
    });

    test("handles ApiError with 404 status code", async () => {
      const app = createFastifyInstance();

      app.get("/test-404", async () => {
        throw new ApiError(404, "Not found");
      });

      const response = await app.inject({
        method: "GET",
        url: "/test-404",
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: {
          message: "Not found",
          type: "api_not_found_error",
        },
      });
    });

    test("handles ApiError with 500 status code", async () => {
      const app = createFastifyInstance();

      app.get("/test-500", async () => {
        throw new ApiError(500, "Internal server error");
      });

      const response = await app.inject({
        method: "GET",
        url: "/test-500",
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: {
          message: "Internal server error",
          type: "api_internal_server_error",
        },
      });
    });

    test("handles ApiError with 409 status code", async () => {
      const app = createFastifyInstance();

      app.get("/test-409", async () => {
        throw new ApiError(409, "Resource conflict");
      });

      const response = await app.inject({
        method: "GET",
        url: "/test-409",
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: {
          message: "Resource conflict",
          type: "api_conflict_error",
        },
      });
    });

    test("handles ApiError with unknown status code", async () => {
      const app = createFastifyInstance();

      app.get("/test-unknown", async () => {
        throw new ApiError(418, "I'm a teapot");
      });

      const response = await app.inject({
        method: "GET",
        url: "/test-unknown",
      });

      expect(response.statusCode).toBe(418);
      expect(response.json()).toEqual({
        error: {
          message: "I'm a teapot",
          type: "unknown_api_error",
        },
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
        { error: "Server error", statusCode: 500 },
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
        { error: "Not found", statusCode: 404 },
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
        { error: "Success with error", statusCode: 200 },
        "HTTP request error occurred",
      );

      loggerErrorSpy.mockRestore();
    });

    test("logs standard errors at error level", async () => {
      const app = createFastifyInstance();

      // Mock the logger error method
      const loggerErrorSpy = vi.spyOn(app.log, "error");

      app.get("/test-standard-error-logging", async () => {
        throw new Error("Standard error");
      });

      await app.inject({
        method: "GET",
        url: "/test-standard-error-logging",
      });

      // Standard errors should be logged at error level with 500 status
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        { error: "Standard error", statusCode: 500 },
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

describe("isDatabaseHealthy", () => {
  test("returns true when database is reachable", async () => {
    // Using PGlite in tests, the database should be healthy
    const result = await isDatabaseHealthy();
    expect(result).toBe(true);
  });
});

describe("health endpoints", () => {
  describe("/health endpoint", () => {
    test("returns 200 with application info", async () => {
      const app = createFastifyInstance();
      registerHealthEndpoint(app);

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
      registerReadinessEndpoint(app);

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
      registerReadinessEndpoint(app);

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
  });
});
