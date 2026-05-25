"use client";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCatalogPresets } from "@/lib/mcp/internal-mcp-catalog.query";
import { usePresetEntityName } from "@/lib/organization.query";
import type { CatalogItem } from "./preset-helpers";

interface InstallPresetPickerProps {
  parent: CatalogItem;
  value: string;
  onChange: (catalogId: string) => void;
  disabled?: boolean;
}

export function InstallPresetPicker({
  parent,
  value,
  onChange,
  disabled,
}: InstallPresetPickerProps) {
  const { data: children = [] } = useCatalogPresets(parent.id);
  const { singular, defaultLabel } = usePresetEntityName();

  if (children.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <Label htmlFor="install-preset">{singular}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id="install-preset">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={parent.id}>
            {parent.name} ({defaultLabel.toLowerCase()})
          </SelectItem>
          {children.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
