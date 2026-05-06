"use client";

import { EditCatalogContent } from "@/app/mcp/registry/_parts/edit-catalog-dialog";
import type { CatalogItem } from "../types";

export function ConfigurationSection({ cat }: { cat: CatalogItem }) {
  return (
    <div className="p-6">
      <EditCatalogContent item={cat} onClose={() => {}} keepOpenOnSave />
    </div>
  );
}
