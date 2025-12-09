"use client";

import type { OrganizationCustomFont } from "@shared";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fonts } from "@/config/themes";

interface FontSelectorProps {
  selectedFont: OrganizationCustomFont;
  onFontSelect: (fontId: OrganizationCustomFont) => void;
}

export function FontSelector({
  selectedFont,
  onFontSelect,
}: FontSelectorProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Font Family</CardTitle>
        <CardDescription>
          Select a font family for your organization
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Select value={selectedFont} onValueChange={onFontSelect}>
          <SelectTrigger className="w-full md:w-64">
            <SelectValue placeholder="Select a font" />
          </SelectTrigger>
          <SelectContent>
            {fonts.map((font) => (
              <SelectItem key={font.id} value={font.id}>
                {font.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardContent>
    </Card>
  );
}
