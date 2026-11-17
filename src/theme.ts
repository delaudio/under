import { fileURLToPath } from "node:url";

/** Colours Under paints itself; embedded tools keep their own palettes. */
export type Palette = {
  /** Behind panes and inside frames. */
  background: string;
  foreground: string;
  /** Focus outline, active menu, drag highlight. */
  accent: string;
  /** Menu bar, header and status line. */
  surface: string;
  /** Sidebar, dropdowns and modals. */
  panel: string;
  /** Outline of panes that do not have focus. */
  border: string;
  /** Secondary text such as inactive tabs. */
  muted: string;
  /** Selected row in lists and the active menu. */
  selection: string;
  directory: string;
};

export const THEMES = ["flat", "classic"] as const;
export type ThemeName = (typeof THEMES)[number];

/** `flat` follows Fresh's flat theme: one dark family, panels told apart by
 * shade rather than by heavy outlines, and a warm yellow for focus. */
export const PALETTES: Record<ThemeName, Palette> = {
  flat: {
    background: "#18191f",
    foreground: "#cdd1da",
    accent: "#ffcc66",
    surface: "#131419",
    panel: "#21232c",
    border: "#2a2d39",
    muted: "#606574",
    selection: "#3a4f78",
    directory: "#8faadc",
  },
  classic: {
    background: "#101014",
    foreground: "#dddde5",
    accent: "#b7a7e8",
    surface: "#20202a",
    panel: "#101014",
    border: "#3a3a44",
    muted: "#8a8a96",
    selection: "#2c2c3a",
    directory: "#b7a7e8",
  },
};

/** The theme's palette with any explicit colour overrides from the config. */
export function palette(config: {
  theme: ThemeName;
  background?: string;
  foreground?: string;
  accent?: string;
}): Palette {
  const base = PALETTES[config.theme] ?? PALETTES.flat;
  return {
    ...base,
    ...(config.background ? { background: config.background } : {}),
    ...(config.foreground ? { foreground: config.foreground } : {}),
    ...(config.accent ? { accent: config.accent } : {}),
  };
}

/** Runtime directory holding Under's Neovim colour schemes (`colors/*.lua`). */
export const neovimRuntime = () =>
  fileURLToPath(new URL("../runtime/nvim", import.meta.url));
