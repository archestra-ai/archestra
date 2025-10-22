import type { FastifyPluginAsync } from "fastify";
import config from "../config";
import db from "../database";
import { systemHealthStatus } from "../metrics";

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", async () => {
    const healthCheck = {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: config.api.version,
      name: config.api.name,
    };

    systemHealthStatus.set({ component: "system" }, 1);

    return healthCheck;
  });

  fastify.get("/health/detailed", async () => {
    const checks: Record<string, unknown> = {
      system: {
        status: "ok",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: config.api.version,
        name: config.api.name,
      },
      database: { status: "checking" },
    };

    let overallStatus = "ok";

    try {
      await db.execute("SELECT 1");
      checks.database = {
        status: "ok",
        message: "Database connection successful",
      };
      systemHealthStatus.set({ component: "database" }, 1);
    } catch (error) {
      checks.database = {
        status: "error",
        message: "Database connection failed",
        error: error instanceof Error ? error.message : "Unknown error",
      };
      overallStatus = "error";
      systemHealthStatus.set({ component: "database" }, 0);
    }

    const providerChecks = await checkLLMProviders();
    checks.providers = providerChecks;

    if (
      providerChecks.some(
        (p: { status: string; provider: string }) => p.status === "error",
      )
    ) {
      overallStatus = "degraded";
    }

    const healthResponse = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      checks,
    };

    systemHealthStatus.set(
      { component: "system" },
      overallStatus === "ok" ? 1 : 0,
    );

    return healthResponse;
  });

  fastify.get("/ready", async () => {
    try {
      await db.execute("SELECT 1");

      return {
        status: "ready",
        timestamp: new Date().toISOString(),
      };
    } catch (_error) {
      return {
        status: "not ready",
        timestamp: new Date().toISOString(),
        error: "Database not accessible",
      };
    }
  });

  fastify.get("/live", async () => {
    return {
      status: "alive",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  });
};

async function checkLLMProviders() {
  const providers = [
    { name: "openai", check: checkOpenAI },
    { name: "anthropic", check: checkAnthropic },
    { name: "gemini", check: checkGemini },
  ];

  const results = await Promise.allSettled(
    providers.map(async ({ name, check }) => {
      try {
        const result = await check();
        return {
          provider: name,
          status: "ok",
          ...result,
        };
      } catch (error) {
        return {
          provider: name,
          status: "error",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }),
  );

  return results.map((result, index) => {
    if (result.status === "fulfilled") {
      const provider = providers[index].name;
      systemHealthStatus.set(
        { component: provider },
        result.value.status === "ok" ? 1 : 0,
      );
      return result.value;
    } else {
      const provider = providers[index].name;
      systemHealthStatus.set({ component: provider }, 0);
      return {
        provider,
        status: "error",
        error: result.reason?.message || "Check failed",
      };
    }
  });
}

async function checkOpenAI() {
  const hasKey = !!process.env.OPENAI_API_KEY;
  if (!hasKey) {
    throw new Error("OpenAI API key not configured");
  }
  return { message: "OpenAI API key configured" };
}

async function checkAnthropic() {
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  if (!hasKey) {
    throw new Error("Anthropic API key not configured");
  }
  return { message: "Anthropic API key configured" };
}

async function checkGemini() {
  const hasKey = !!process.env.GOOGLE_AI_API_KEY;
  if (!hasKey) {
    throw new Error("Google AI API key not configured");
  }
  return { message: "Google AI API key configured" };
}

export default healthRoutes;
