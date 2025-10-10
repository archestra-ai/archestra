import { API_BASE_URL } from "@shared/api-client/client.gen";
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    apiBaseUrl: API_BASE_URL,
  });
}
