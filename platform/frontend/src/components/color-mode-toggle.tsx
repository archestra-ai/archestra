"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";

export function ColorModeToggle() {
  const { setTheme } = useTheme();

  return (
    <>
      <Button
        variant="outline"
        size="icon"
        className="dark:hidden cursor-pointer"
        onClick={() => setTheme("dark")}
      >
        <Sun className="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="hidden dark:block cursor-pointer"
        onClick={() => setTheme("light")}
      >
        <Moon className="h-[1.2rem] w-[1.2rem] transition-all mx-auto" />
      </Button>
    </>
  );
}
