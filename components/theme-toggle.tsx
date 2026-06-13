"use client";

import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

export function ThemeToggle() {
  const { setTheme, theme } = useTheme();

  return (
    <button
      onClick={() => setTheme(theme === "light" ? "dark" : "light")}
      className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-background hover:bg-muted text-foreground transition-colors"
      aria-label="Toggle theme"
    >
      <Sun className="size-[1.125rem] transition-all dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute size-[1.125rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
      <span className="sr-only">Toggle theme</span>
    </button>
  );
}
