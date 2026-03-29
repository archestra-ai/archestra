/**
 * REST API: /api/agents/:agentId/schedule-triggers
 *
 * GET    — list all schedule triggers for an agent
 * POST   — create a new schedule trigger
 */

import { NextRequest, NextResponse } from "next/server";
import {
  createScheduleTrigger,
  listScheduleTriggers,
} from "@/lib/scheduler/store";
import { CreateScheduleTriggerInput } from "@/lib/scheduler/types";

interface RouteParams {
  params: { agentId: string };
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const triggers = await listScheduleTriggers(params.agentId);
    return NextResponse.json(triggers);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const body = (await req.json()) as Omit<CreateScheduleTriggerInput, "agentId">;

    if (!body.name || typeof body.name !== "string") {
      return NextResponse.json(
        { error: "Field 'name' is required and must be a string." },
        { status: 400 }
      );
    }
    if (!body.schedule || typeof body.schedule !== "object") {
      return NextResponse.json(
        { error: "Field 'schedule' is required." },
        { status: 400 }
      );
    }

    const input: CreateScheduleTriggerInput = {
      ...body,
      agentId: params.agentId,
    };

    const trigger = await createScheduleTrigger(input);
    return NextResponse.json(trigger, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    const status = message.includes("Invalid") || message.includes("must") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
