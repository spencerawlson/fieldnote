import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';

export interface ThemeInfo {
  key: string;
  name: string;
  description: string;
  accent: string;
  cover: string;
  coverInk: string;
  surface: string;
  serif: boolean;
}

let cache: { report: ThemeInfo[]; presentation: ThemeInfo[] } | null = null;

/** Themes are static server-side, so one fetch per session is enough. */
export function useThemes(kind: 'report' | 'presentation'): ThemeInfo[] {
  const [themes, setThemes] = useState<ThemeInfo[]>(cache?.[kind] ?? []);

  useEffect(() => {
    if (cache) {
      setThemes(cache[kind]);
      return;
    }
    void api
      .get<{ themes: { report: ThemeInfo[]; presentation: ThemeInfo[] } }>('/api/templates')
      .then((response) => {
        cache = response.themes;
        setThemes(response.themes[kind]);
      })
      .catch(() => setThemes([]));
  }, [kind]);

  return themes;
}

/**
 * Theme chooser.
 *
 * Shows what the theme looks like rather than naming a colour: a miniature
 * cover, the accent, and whether the body is serif. Choosing one changes the
 * live preview and the exported DOCX, PDF, HTML and PPTX identically.
 */
export function ThemePicker({
  kind,
  value,
  onChange,
}: {
  kind: 'report' | 'presentation';
  value: string;
  onChange: (key: string) => void;
}) {
  const themes = useThemes(kind);
  if (themes.length === 0) return null;

  return (
    <div className="stack tight">
      <span className="label">Look</span>
      <div className="theme-grid">
        {themes.map((theme) => (
          <button
            key={theme.key}
            type="button"
            className={`theme-swatch ${value === theme.key ? 'selected' : ''}`}
            onClick={() => onChange(theme.key)}
            title={theme.description}
            aria-pressed={value === theme.key}
          >
            <span className="preview" style={{ background: theme.cover }}>
              <span className="bar" style={{ background: theme.accent }} />
              <span className="line long" style={{ background: theme.coverInk, opacity: 0.9 }} />
              <span className="line" style={{ background: theme.coverInk, opacity: 0.45 }} />
            </span>
            <span className="name">
              {theme.name}
              {theme.serif ? <span className="tiny dim"> · serif</span> : null}
            </span>
          </button>
        ))}
      </div>
      <span className="hint">{themes.find((t) => t.key === value)?.description}</span>
    </div>
  );
}

/**
 * Maps a theme onto CSS custom properties so an in-app preview matches the
 * exported document. The same tokens the HTML export writes are used here.
 */
export function themeStyle(theme: ThemeInfo | undefined): React.CSSProperties {
  if (!theme) return {};
  return {
    ['--doc-accent' as string]: theme.accent,
    ['--doc-cover' as string]: theme.cover,
    ['--doc-cover-ink' as string]: theme.coverInk,
    ['--doc-surface' as string]: theme.surface,
    ['--doc-font' as string]: theme.serif
      ? 'Cambria, Georgia, "Times New Roman", serif'
      : 'var(--font)',
  };
}
