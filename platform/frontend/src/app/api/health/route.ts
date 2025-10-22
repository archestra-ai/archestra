import { type NextRequest, NextResponse } from "next/server";

export async function GET(_request: NextRequest) {
  try {
    const healthCheck = {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.NEXT_PUBLIC_APP_VERSION || "unknown",
      environment: process.env.NODE_ENV || "development",
      checks: {
        api: await checkBackendAPI(),
        database: {
          status: "not_applicable",
          message: "Frontend does not connect directly to database",
        },
      },
    };

    const statusCode = healthCheck.checks.api.status === "error" ? 503 : 200;

    return NextResponse.json(healthCheck, { status: statusCode });
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 503 },
    );
  }
}

async function checkBackendAPI() {
  try {
    const backendUrl =
      process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:9000";
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${backendUrl}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return {
        status: "ok",
        message: "Backend API is accessible",
        responseTime: Date.now(),
      };
    } else {
      return {
        status: "error",
        message: `Backend API returned ${response.status}`,
        responseTime: Date.now(),
      };
    }
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error ? error.message : "Backend API check failed",
      responseTime: Date.now(),
    };
  }
}

export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}
