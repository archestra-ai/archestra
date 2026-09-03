import * as simpleIcons from "simple-icons";
import {
  buildIconList,
  filterIcons,
} from "@/components/service-logo-picker.utils";

const CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";
const PAGE_SIZE = 120;
const ICONS = buildIconList(simpleIcons);

export function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const query = searchParams.get("q") ?? "";
  const offset = parseNonNegativeInteger(searchParams.get("offset"), 0);
  const limit = Math.max(
    1,
    Math.min(
      parseNonNegativeInteger(searchParams.get("limit"), PAGE_SIZE),
      PAGE_SIZE,
    ),
  );
  const matchingIcons = filterIcons(ICONS, query);

  return Response.json(
    {
      data: matchingIcons.slice(offset, offset + limit),
      total: matchingIcons.length,
    },
    {
      headers: {
        "Cache-Control": CACHE_CONTROL,
      },
    },
  );
}

function parseNonNegativeInteger(value: string | null, fallback: number) {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
