"use client";

import type { archestraCatalogTypes } from "@shared";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { useMcpServerCategories } from "@/lib/external-mcp-catalog.query";

export type ServerType = "all" | "remote" | "local";

export type SelectedCategory =
  | "all"
  | archestraCatalogTypes.GetMcpServerCategoriesResponse["categories"][number];

interface CatalogFiltersProps {
  onFiltersChange: (filters: {
    type: ServerType;
    category: SelectedCategory;
  }) => void;
}

export function CatalogFilters({ onFiltersChange }: CatalogFiltersProps) {
  const [selectedType, setSelectedType] = useState<ServerType>("remote");
  const [selectedCategory, setSelectedCategory] =
    useState<SelectedCategory>("all");

  const { data: availableCategories = [] } = useMcpServerCategories();

  const handleTypeChange = (type: ServerType) => {
    setSelectedType(type);
    onFiltersChange({ type, category: selectedCategory });
  };

  const handleCategoryToggle = (category: SelectedCategory) => {
    const newCategory = category === "all" ? "all" : category;
    setSelectedCategory(newCategory);
    onFiltersChange({ type: selectedType, category: newCategory });
  };

  const isAllCategoriesSelected = selectedCategory === "all";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-muted-foreground">Type:</span>
        <Badge
          variant={selectedType === "all" ? "default" : "outline"}
          className="cursor-pointer"
          onClick={() => handleTypeChange("all")}
        >
          All
        </Badge>
        <Badge
          variant={selectedType === "remote" ? "default" : "outline"}
          className="cursor-pointer"
          onClick={() => handleTypeChange("remote")}
        >
          Remote
        </Badge>
        <Badge
          variant={selectedType === "local" ? "default" : "outline"}
          className="cursor-pointer"
          onClick={() => handleTypeChange("local")}
        >
          Local
        </Badge>
      </div>

      <div className="flex items-start gap-2 flex-wrap">
        <span className="text-sm font-medium text-muted-foreground pt-1">
          Category:
        </span>
        <div className="flex flex-wrap gap-2">
          <Badge
            variant={isAllCategoriesSelected ? "default" : "outline"}
            className="cursor-pointer"
            onClick={() => handleCategoryToggle("all")}
          >
            All
          </Badge>
          {availableCategories.map((category) => (
            <Badge
              key={category}
              variant={selectedCategory === category ? "default" : "outline"}
              className="cursor-pointer"
              onClick={() => handleCategoryToggle(category)}
            >
              {category}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}
