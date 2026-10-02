"use client";

import ConnectionPage from "@/app/connection/page";

// The production page, unchanged, so every prototype can be compared against
// what users see today. It reads live data and keeps its own URL params.
export default function TodayVariant() {
  return <ConnectionPage />;
}
