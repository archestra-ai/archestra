"use client";

import { Badge } from "@/components/ui/badge";

type ServerType = "all" | "remote" | "local";

interface CatalogFiltersProps {
  selectedType: ServerType;
  onTypeChange: (type: ServerType) => void;
  selectedCategory: string | null;
  onCategoryChange: (category: string | null) => void;
  availableCategories: string[];
}

export function CatalogFilters({
  selectedType,
  onTypeChange,
  selectedCategory,
  onCategoryChange,
  availableCategories,
}: CatalogFiltersProps) {
  const handleCategoryToggle = (category: string) => {
    if (category === "all") {
      onCategoryChange(null);
    } else {
      onCategoryChange(category);
    }
  };

  const isAllCategoriesSelected = selectedCategory === null;

  return (
    <div className="space-y-3">
      {/* Type Filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-muted-foreground">Type:</span>
        <Badge
          variant={selectedType === "all" ? "default" : "outline"}
          className="cursor-pointer hover:bg-secondary"
          onClick={() => onTypeChange("all")}
        >
          All
        </Badge>
        <Badge
          variant={selectedType === "remote" ? "default" : "outline"}
          className="cursor-pointer hover:bg-secondary"
          onClick={() => onTypeChange("remote")}
        >
          Remote
        </Badge>
        <Badge
          variant={selectedType === "local" ? "default" : "outline"}
          className="cursor-pointer hover:bg-secondary"
          onClick={() => onTypeChange("local")}
        >
          Local
        </Badge>
      </div>

      {/* Category Filter */}
      <div className="flex items-start gap-2 flex-wrap">
        <span className="text-sm font-medium text-muted-foreground pt-1">
          Category:
        </span>
        <div className="flex flex-wrap gap-2">
          <Badge
            variant={isAllCategoriesSelected ? "default" : "outline"}
            className="cursor-pointer hover:bg-secondary"
            onClick={() => handleCategoryToggle("all")}
          >
            All
          </Badge>
          {availableCategories.map((category) => (
            <Badge
              key={category}
              variant={selectedCategory === category ? "default" : "outline"}
              className="cursor-pointer hover:bg-secondary"
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
