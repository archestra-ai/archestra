"use client";

import { Moon, Sun, TreesIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

interface LightDarkButtonsProps {
  size?: "sm" | "default";
}

export function LightDarkButtons({ size = "default" }: LightDarkButtonsProps) {
  const { theme, setTheme } = useTheme();

  return (
    <div className="flex gap-1">
      <Button
        variant={theme === "light" ? "default" : "outline"}
        size={size}
        className="gap-1.5"
        onClick={() => setTheme("light")}
        aria-pressed={theme === "light"}
      >
        <Sun className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />
        Light
      </Button>
      <Button
        variant={theme === "dark" ? "default" : "outline"}
        size={size}
        className="gap-1.5"
        onClick={() => setTheme("dark")}
        aria-pressed={theme === "dark"}
      >
        <Moon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />
        Dark
      </Button>
      <Button
        variant={theme === "forbidden-forest" ? "default" : "outline"}
        size={size}
        className="gap-1.5"
        onClick={() => setTheme("forbidden-forest")}
        aria-pressed={theme === "forbidden-forest"}
      >
        <TreesIcon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />
        Forbidden Forest
      </Button>
    </div>
  );
}
