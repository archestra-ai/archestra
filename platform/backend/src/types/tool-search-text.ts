import { z } from "zod";

const ToolSearchTextStatusSchema = z.enum(["ready", "empty", "failed"]);

export type ToolSearchTextStatus = z.infer<typeof ToolSearchTextStatusSchema>;

export type ParsedSearchText =
  | { status: "ready"; searchText: string }
  | { status: "empty" }
  | { status: "failed" };
