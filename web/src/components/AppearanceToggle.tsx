import { useEffect, useState } from 'react';

export type Appearance = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'fieldnote.appearance';

/**
 * Applies the choice to the document root.
 *
 * "system" stamps nothing and lets the media query in the stylesheet decide;
 * an explicit choice stamps `data-theme`, which the stylesheet declares for
 * both directions so the toggle wins whichever way the OS is set.
 */
function apply(appearance: Appearance): void {
  const root = document.documentElement;
  if (appearance === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', appearance);
}

function read(): Appearance {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    /* private browsing or blocked storage — fall back to system */
  }
  return 'system';
}

/** Applied before first paint so there is no flash of the wrong theme. */
export function initAppearance(): void {
  apply(read());
}

const OPTIONS: { value: Appearance; label: string; glyph: string }[] = [
  { value: 'light', label: 'Light', glyph: '☀' },
  { value: 'dark', label: 'Dark', glyph: '☾' },
  { value: 'system', label: 'System', glyph: '◐' },
];

export function AppearanceToggle() {
  const [appearance, setAppearance] = useState<Appearance>(read);

  useEffect(() => {
    apply(appearance);
    try {
      localStorage.setItem(STORAGE_KEY, appearance);
    } catch {
      /* not fatal — the choice simply will not persist */
    }
  }, [appearance]);

  return (
    <div className="appearance" role="group" aria-label="Appearance">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`appearance-option ${appearance === option.value ? 'active' : ''}`}
          onClick={() => setAppearance(option.value)}
          title={option.label}
          aria-pressed={appearance === option.value}
        >
          <span aria-hidden>{option.glyph}</span>
          <span className="sr-only">{option.label}</span>
        </button>
      ))}
    </div>
  );
}
