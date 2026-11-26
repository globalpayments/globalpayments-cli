import type { ColorSpec, TextStyle } from './color.js';

/**
 * Global Payments brand palette (2025 identity, gpbrandguide.com).
 *
 * How the guide maps onto a terminal:
 * - White and Global Blue are the primary identifiers, so the 'g' chip in the
 *   lockup and the environment badges are white on a Global Blue field, the
 *   guide's primary logo treatment. The ASCII banner stays uncoloured. Global Blue as *text* only works on light backgrounds, so
 *   dark terminals carry accents in Pulse Blue, the guide's connector colour.
 * - The guide defines no green and leads positive data with blue, so a passing
 *   check is a blue tick. Raspberry is reserved for negatives (failures only),
 *   Creamsicle is the in-palette warning, Sunshine marks commands to copy.
 * - No gradients: the guide rules them out for software elements.
 * - Muted text uses the terminal's own grey so it stays readable whatever
 *   background the developer runs.
 */
export const BRAND = {
  globalBlue: '#262AFF',
  deepBlue: '#1B1EC6',
  pulseBlue: '#1CABFF',
  sunshine: '#FFCC00',
  creamsicle: '#FDA052',
  raspberry: '#F4364C',
  grape: '#87179D',
  charcoal: '#595959',
  smoke: '#C4C4C4',
  white: '#FFFFFF',
  black: '#0C0C0C'
} as const;

const c = (hex: string | undefined, basic: number): ColorSpec => (hex ? { hex, basic } : { basic });

// Terminal-palette colours (no hex): the user's own theme decides the shade.
const TERM = {
  grey: c(undefined, 90),
  red: c(undefined, 31),
  green: c(undefined, 32),
  yellow: c(undefined, 33),
  blue: c(undefined, 34),
  cyan: c(undefined, 36),
  white: c(undefined, 97),
  black: c(undefined, 30)
};

export type ThemeName = 'gp' | 'gp-light' | 'classic' | 'mono';
export const THEME_NAMES: ThemeName[] = ['gp', 'gp-light', 'classic', 'mono'];

/** Semantic roles. Renderers ask for a role, never for a colour. */
export interface Theme {
  name: ThemeName;
  label: string;
  description: string;
  styles: {
    /** Headings and emphasis. */
    heading: TextStyle;
    strong: TextStyle;
    /** Brand accent: identifiers, selections, links. */
    accent: TextStyle;
    /** Something worked. */
    success: TextStyle;
    /** Something failed. Negative states only. */
    danger: TextStyle;
    /** Needs attention but is not a failure. */
    warning: TextStyle;
    /** Secondary text: hints, labels, details. */
    muted: TextStyle;
    /** A command the reader can copy and run. */
    command: TextStyle;
    /** Hyperlink text. */
    link: TextStyle;
    /** The 'g' chip in the one-line lockup. */
    logo: TextStyle;
    /** Environment badges. */
    badgeSandbox: TextStyle;
    badgeProduction: TextStyle;
    badgeNeutral: TextStyle;
    /** The highlighted row in a picker. */
    selected: TextStyle;
  };
}

const blueField: TextStyle = { fg: c(BRAND.white, 97), bg: c(BRAND.globalBlue, 34) };

export const THEMES: Record<ThemeName, Theme> = {
  gp: {
    name: 'gp',
    label: 'Global Payments',
    description: 'Brand colours tuned for dark terminals (default)',
    styles: {
      heading: { bold: true },
      strong: { bold: true },
      accent: { fg: c(BRAND.pulseBlue, 94) },
      success: { fg: c(BRAND.pulseBlue, 94) },
      danger: { fg: c(BRAND.raspberry, 91) },
      warning: { fg: c(BRAND.creamsicle, 93) },
      muted: { fg: TERM.grey },
      command: { fg: c(BRAND.sunshine, 93) },
      link: { fg: c(BRAND.pulseBlue, 94), underline: true },
      logo: blueField,
      badgeSandbox: { ...blueField, bold: true },
      badgeProduction: { fg: c(BRAND.black, 30), bg: c(BRAND.creamsicle, 33), bold: true },
      badgeNeutral: { fg: c(BRAND.white, 97), bg: c(BRAND.charcoal, 90) },
      selected: { fg: c(BRAND.pulseBlue, 94), bold: true }
    }
  },
  'gp-light': {
    name: 'gp-light',
    label: 'Global Payments light',
    description: 'Brand colours tuned for light terminals',
    styles: {
      heading: { bold: true },
      strong: { bold: true },
      accent: { fg: c(BRAND.globalBlue, 34) },
      success: { fg: c(BRAND.globalBlue, 34) },
      danger: { fg: c(BRAND.raspberry, 31) },
      warning: { fg: TERM.yellow },
      muted: { fg: TERM.grey },
      command: { fg: c(BRAND.globalBlue, 34), bold: true },
      link: { fg: c(BRAND.globalBlue, 34), underline: true },
      logo: blueField,
      badgeSandbox: { ...blueField, bold: true },
      badgeProduction: { fg: c(BRAND.black, 30), bg: c(BRAND.creamsicle, 33), bold: true },
      badgeNeutral: { fg: c(BRAND.white, 97), bg: c(BRAND.charcoal, 90) },
      selected: { fg: c(BRAND.globalBlue, 34), bold: true }
    }
  },
  classic: {
    name: 'classic',
    label: 'Classic',
    description: "Your terminal's own palette: green for pass, red for fail",
    styles: {
      heading: { bold: true },
      strong: { bold: true },
      accent: { fg: TERM.cyan },
      success: { fg: TERM.green },
      danger: { fg: TERM.red },
      warning: { fg: TERM.yellow },
      muted: { fg: TERM.grey },
      command: { fg: TERM.yellow },
      link: { fg: TERM.cyan, underline: true },
      logo: { fg: TERM.white, bg: TERM.blue },
      badgeSandbox: { fg: TERM.white, bg: TERM.blue, bold: true },
      badgeProduction: { fg: TERM.black, bg: TERM.yellow, bold: true },
      badgeNeutral: { fg: TERM.white, bg: TERM.grey },
      selected: { fg: TERM.cyan, bold: true }
    }
  },
  mono: {
    name: 'mono',
    label: 'Monochrome',
    description: 'No colour, only bold and underline',
    styles: {
      heading: { bold: true },
      strong: { bold: true },
      accent: {},
      success: {},
      danger: { bold: true },
      warning: { bold: true },
      muted: { dim: true },
      command: { bold: true },
      link: { underline: true },
      logo: {},
      badgeSandbox: { bold: true },
      badgeProduction: { bold: true, underline: true },
      badgeNeutral: {},
      selected: { bold: true, underline: true }
    }
  }
};

export function isThemeName(value: string): value is ThemeName {
  return (THEME_NAMES as string[]).includes(value);
}
