"use client";

import { DARK_ONLY_THEMES, LIGHT_ONLY_THEMES, type ThemeId } from "@shared";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface LightDarkToggleProps {
  currentThemeId?: ThemeId;
}

export function LightDarkToggle({ currentThemeId }: LightDarkToggleProps) {
  const { theme, setTheme } = useTheme();

  const isLightOnly = currentThemeId
    ? (LIGHT_ONLY_THEMES as readonly string[]).includes(currentThemeId)
    : false;
  const isDarkOnly = currentThemeId
    ? (DARK_ONLY_THEMES as readonly string[]).includes(currentThemeId)
    : false;

  // Auto-switch to appropriate mode when theme restrictions change
  useEffect(() => {
    if (isLightOnly && theme === "dark") {
      setTheme("light");
    } else if (isDarkOnly && theme === "light") {
      setTheme("dark");
    }
  }, [isLightOnly, isDarkOnly, theme, setTheme]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Theme Mode</CardTitle>
        <CardDescription>
          Switch between light and dark modes for your interface.
          {isLightOnly && " This theme only supports light mode."}
          {isDarkOnly && " This theme only supports dark mode."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          <Button
            variant={theme === "light" ? "default" : "outline"}
            className="flex-1 gap-2"
            onClick={() => setTheme("light")}
            disabled={isDarkOnly}
          >
            <Sun className="h-4 w-4" />
            Light
          </Button>
          <Button
            variant={theme === "dark" ? "default" : "outline"}
            className="flex-1 gap-2"
            onClick={() => setTheme("dark")}
            disabled={isLightOnly}
          >
            <Moon className="h-4 w-4" />
            Dark
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
