"use client";

import { useOpenappaNavigation } from "./openappa-navigation";
import { ToolTable } from "./tool-table";

/** Scaffold placeholder; WP3 replaces the body. */
export function ToolsTab() {
  const { toolsServer } = useOpenappaNavigation();
  return <ToolTable initialServer={toolsServer ?? undefined} />;
}
