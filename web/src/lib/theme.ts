// Theme: system preference + manual override persisted in localStorage.
// The pre-paint script in index.html sets the initial class so we never flash.

import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
export type ThemeChoice = Theme | "system";

const STORAGE_KEY = "viewer.theme";

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function readChoice(): ThemeChoice {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function useTheme() {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readChoice());

  useEffect(() => {
    const resolved: Theme = choice === "system" ? systemTheme() : choice;
    applyTheme(resolved);
    if (choice === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => applyTheme(systemTheme());
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
  }, [choice]);

  function setChoice(c: ThemeChoice) {
    if (c === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, c);
    setChoiceState(c);
  }

  const resolved: Theme = choice === "system" ? systemTheme() : choice;
  return { choice, resolved, setChoice };
}
