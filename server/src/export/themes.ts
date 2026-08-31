/**
 * Visual themes.
 *
 * A theme controls how a document or deck *looks* — typography, accent colour,
 * cover treatment, callout styling. It never controls what the document *says*;
 * that is the template's job (structure) and the project's job (content).
 *
 * One registry serves every renderer, so a report exported as DOCX, PDF and
 * HTML looks like the same document, and a deck looks the same in PPTX and PDF.
 * Colours are stored without the `#` because that is what DOCX and PPTX want;
 * the CSS and PDF renderers add it.
 */

export interface ThemePalette {
  /** Body text. */
  ink: string;
  /** Secondary text: captions, metadata, footers. */
  muted: string;
  /** Headings. Often the same as ink; a coloured theme differs. */
  heading: string;
  /** Rules, table borders. */
  line: string;
  /** Links, section rules, slide accents. */
  accent: string;
  /** Page background. */
  page: string;
  /** Code blocks and table headers. */
  surface: string;
  /** Cover-page and title-slide background. */
  cover: string;
  /** Text on the cover background. */
  coverInk: string;
  coverMuted: string;
}

export interface ThemeFonts {
  /** Body text. Must be a font Word and PowerPoint can be expected to have. */
  body: string;
  /** Headings. */
  heading: string;
  /** Code. */
  mono: string;
  /** pdfkit ships 14 standard fonts; these name which to use. */
  pdfBody: 'Helvetica' | 'Times-Roman';
  pdfBold: 'Helvetica-Bold' | 'Times-Bold';
  pdfItalic: 'Helvetica-Oblique' | 'Times-Italic';
}

export interface Theme {
  key: string;
  name: string;
  description: string;
  /** Which outputs it is offered for. */
  applies: ('report' | 'presentation')[];
  palette: ThemePalette;
  fonts: ThemeFonts;
  /** Title-page treatment. */
  cover: 'plain' | 'banded' | 'filled';
  /** Heading rules under section titles in reports. */
  sectionRule: boolean;
  /** Base body size in points. Academic work often wants 11–12pt. */
  bodyPt: number;
}

const SANS: ThemeFonts = {
  body: 'Calibri',
  heading: 'Calibri',
  mono: 'Consolas',
  pdfBody: 'Helvetica',
  pdfBold: 'Helvetica-Bold',
  pdfItalic: 'Helvetica-Oblique',
};

const SERIF: ThemeFonts = {
  body: 'Cambria',
  heading: 'Cambria',
  mono: 'Consolas',
  pdfBody: 'Times-Roman',
  pdfBold: 'Times-Bold',
  pdfItalic: 'Times-Italic',
};

export const THEMES: Theme[] = [
  {
    key: 'slate',
    name: 'Slate',
    description: 'Neutral and professional. Blue accent, sans-serif, restrained.',
    applies: ['report', 'presentation'],
    palette: {
      ink: '111827',
      muted: '6B7280',
      heading: '111827',
      line: 'E5E7EB',
      accent: '1D4ED8',
      page: 'FFFFFF',
      surface: 'F3F4F6',
      cover: '0F172A',
      coverInk: 'F8FAFC',
      coverMuted: '94A3B8',
    },
    fonts: SANS,
    cover: 'banded',
    sectionRule: true,
    bodyPt: 11,
  },
  {
    key: 'academic',
    name: 'Academic',
    description: 'Serif body, plain title page, conservative spacing. For assessed work.',
    applies: ['report', 'presentation'],
    palette: {
      ink: '1A1A1A',
      muted: '595959',
      heading: '1A1A1A',
      line: 'D9D9D9',
      accent: '2F5496',
      page: 'FFFFFF',
      surface: 'F2F2F2',
      cover: 'FFFFFF',
      coverInk: '1A1A1A',
      coverMuted: '595959',
    },
    fonts: SERIF,
    cover: 'plain',
    sectionRule: false,
    bodyPt: 12,
  },
  {
    key: 'midnight',
    name: 'Midnight',
    description: 'Dark covers and slides with a bright accent. Strong on a projector.',
    applies: ['report', 'presentation'],
    palette: {
      ink: '111827',
      muted: '6B7280',
      heading: '0F172A',
      line: 'E2E8F0',
      accent: '4F46E5',
      page: 'FFFFFF',
      surface: 'F1F5F9',
      cover: '020617',
      coverInk: 'F8FAFC',
      coverMuted: '94A3B8',
    },
    fonts: SANS,
    cover: 'filled',
    sectionRule: true,
    bodyPt: 11,
  },
  {
    key: 'forest',
    name: 'Forest',
    description: 'Green accent, warm neutrals. Calm without being bland.',
    applies: ['report', 'presentation'],
    palette: {
      ink: '1C1917',
      muted: '57534E',
      heading: '064E3B',
      line: 'E7E5E4',
      accent: '047857',
      page: 'FFFFFF',
      surface: 'F5F5F4',
      cover: '022C22',
      coverInk: 'F0FDF4',
      coverMuted: '86EFAC',
    },
    fonts: SANS,
    cover: 'banded',
    sectionRule: true,
    bodyPt: 11,
  },
  {
    key: 'ember',
    name: 'Ember',
    description: 'Warm accent for incident reviews and postmortems.',
    applies: ['report', 'presentation'],
    palette: {
      ink: '1C1917',
      muted: '57534E',
      heading: '7C2D12',
      line: 'E7E5E4',
      accent: 'C2410C',
      page: 'FFFFFF',
      surface: 'FAF5F0',
      cover: '431407',
      coverInk: 'FFF7ED',
      coverMuted: 'FDBA74',
    },
    fonts: SANS,
    cover: 'filled',
    sectionRule: true,
    bodyPt: 11,
  },
  {
    key: 'mono',
    name: 'Technical',
    description: 'Tight, high-density, monospaced headings. For engineering readers.',
    applies: ['report', 'presentation'],
    palette: {
      ink: '18181B',
      muted: '52525B',
      heading: '18181B',
      line: 'E4E4E7',
      accent: '0891B2',
      page: 'FFFFFF',
      surface: 'F4F4F5',
      cover: '18181B',
      coverInk: 'FAFAFA',
      coverMuted: 'A1A1AA',
    },
    fonts: { ...SANS, heading: 'Consolas' },
    cover: 'banded',
    sectionRule: true,
    bodyPt: 10.5,
  },
];

export const DEFAULT_THEME = THEMES[0]!;

export function getTheme(key: string | null | undefined): Theme {
  return THEMES.find((theme) => theme.key === key) ?? DEFAULT_THEME;
}

export function themesFor(kind: 'report' | 'presentation'): Theme[] {
  return THEMES.filter((theme) => theme.applies.includes(kind));
}

/** `#RRGGBB` for CSS and pdfkit. */
export function hex(colour: string): string {
  return `#${colour}`;
}

/**
 * Callout colouring is derived from the theme rather than fixed, so an ember
 * report does not sprout blue inference boxes. Provenance semantics stay
 * constant — inference is always distinct from recommendation — while the hue
 * follows the theme.
 */
export interface CalloutStyle {
  label: string;
  fill: string;
  bar: string;
  ink: string;
}

export function calloutStyles(theme: Theme): Record<string, CalloutStyle> {
  return {
    note: { label: 'Note', fill: theme.palette.surface, bar: theme.palette.muted, ink: theme.palette.ink },
    warning: { label: 'Caution', fill: 'FEF3C7', bar: 'B45308', ink: '7C2D12' },
    inference: { label: 'Inferred', fill: 'EEF2FF', bar: '6366F1', ink: '3730A3' },
    recommendation: { label: 'Recommendation', fill: 'ECFDF5', bar: '059669', ink: '065F46' },
  };
}
