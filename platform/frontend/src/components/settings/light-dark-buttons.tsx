"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface LightDarkButtonsProps {
  isLightOnly?: boolean;
  isDarkOnly?: boolean;
  size?: "sm" | "default";
}

export function LightDarkButtons({
  isLightOnly = false,
  isDarkOnly = false,
  size = "default",
}: LightDarkButtonsProps) {
  const { theme, setTheme } = useTheme();

  // Keep a ref so the effect can always call the latest setTheme without
  // adding it to the dependency array. next-themes recreates setTheme on
  // every mode change (useCallback([a])), which would cause the correction
  // effect to fire on every user-initiated mode switch — potentially
  // reverting the new mode before it sticks.
  const setThemeRef = useRef(setTheme);
  setThemeRef.current = setTheme;

  useEffect(() => {
    if (isLightOnly) {
      setThemeRef.current("light");
    } else if (isDarkOnly) {
      setThemeRef.current("dark");
    }
  }, [isLightOnly, isDarkOnly]);

  return (
    <div className="flex gap-1">
      <ModeButton
        active={theme === "light"}
        disabled={isDarkOnly}
        disabledTooltip="This theme only supports dark mode"
        size={size}
        onClick={() => setTheme("light")}
        icon={<Sun className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />}
        label="Light"
      />
      <ModeButton
        active={theme === "dark"}
        disabled={isLightOnly}
        disabledTooltip="This theme only supports light mode"
        size={size}
        onClick={() => setTheme("dark")}
        icon={<Moon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />}
        label="Dark"
      />
    </div>
  );
}

interface ModeButtonProps {
  active: boolean;
  disabled: boolean;
  disabledTooltip: string;
  size: "sm" | "default";
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

function ModeButton({
  active,
  disabled,
  disabledTooltip,
  size,
  onClick,
  icon,
  label,
}: ModeButtonProps) {
  const button = (
    <Button
      variant={active ? "default" : "outline"}
      size={size}
      className="gap-1.5"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
    >
      {icon}
      {label}
    </Button>
  );

  if (!disabled) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-not-allowed">{button}</span>
      </TooltipTrigger>
      <TooltipContent>{disabledTooltip}</TooltipContent>
    </Tooltip>
  );
}
