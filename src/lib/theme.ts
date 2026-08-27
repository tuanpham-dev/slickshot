export type ThemeOverride = "system" | "light" | "dark";

const STORAGE_KEY = "slickshot:theme";

export function applyTheme(override: ThemeOverride) {
  const root = document.documentElement;
  if (override === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", override);
  }
}

export function loadStoredTheme(): ThemeOverride {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
}

export function storeTheme(override: ThemeOverride) {
  window.localStorage.setItem(STORAGE_KEY, override);
  applyTheme(override);
}

export function initTheme() {
  applyTheme(loadStoredTheme());
}
