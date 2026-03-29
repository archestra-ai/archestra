/**
 * REST API: /api/agents/:agentId/schedule-triggers/:triggerId
 *
 * GET    — fetch a single trigger
 * PATCH  — update name / schedule / status / payload
 * DELETE — remove a trigger
 */

import { NextRequest, NextResponse } from "next/server";
import {
  deleteScheduleTrigger,
  getScheduleTrigger,
  updateScheduleTrigger,
} from "@/lib/scheduler/store";
import { UpdateScheduleTriggerInput } from "@/lib/scheduler/types";

interface RouteParams {
  params: { agentId: string; triggerId: string };
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const trigger = await getScheduleTrigger(params.triggerId);
    if (!trigger || trigger.agentId !== params.agentId) {
      return NextResponse.json({ error: "Trigger not found." }, { status: 404 });
    }
    return NextResponse.json(trigger);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const existing = await getScheduleTrigger(params.triggerId);
    if (!existing || existing.agentId !== params.agentId) {
      return NextResponse.json({ error: "Trigger not found." }, { status: 404 });
    }

    const body = (await req.json()) as UpdateScheduleTriggerInput;
    const updated = await updateScheduleTrigger(params.triggerId, body);
    return NextResponse.json(updated);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    const status = message.includes("Invalid") || message.includes("must") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const existing = await getScheduleTrigger(params.triggerId);
    if (!existing || existing.agentId !== params.agentId) {
      return NextResponse.json({ error: "Trigger not found." }, { status: 404 });
    }

    await deleteScheduleTrigger(params.triggerId);
    return new NextResponse(null, { status: 204 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
