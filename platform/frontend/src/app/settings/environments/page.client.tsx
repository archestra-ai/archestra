"use client";

import { useHasPermissions } from "@/lib/auth/auth.query";
import { EnvironmentsSection } from "../../mcp/registry/_parts/environments-section";

export default function EnvironmentsPageClient() {
  const { data: canEdit } = useHasPermissions({
    environment: ["admin"],
  });

  return <EnvironmentsSection canEdit={canEdit ?? false} />;
}
