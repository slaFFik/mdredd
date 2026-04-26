import { useEffect, useState, type JSX } from 'react';
import { Hint } from './Hint.js';

type ThemeMode = 'auto' | 'light' | 'dark';

const STORAGE_KEY = 'mdredd.theme';
export const REPO_URL = 'https://github.com/slaFFik/mdredd';

function loadMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark') return raw;
  } catch {
    /* localStorage may be unavailable; fall back to auto */
  }
  return 'auto';
}

function persistMode(mode: ThemeMode): void {
  try {
    if (mode === 'auto') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

function applyMode(mode: ThemeMode): void {
  const el = document.documentElement;
  if (mode === 'auto') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', mode);
}

export function Footer(): JSX.Element {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const m = loadMode();
    applyMode(m);
    return m;
  });

  useEffect(() => {
    applyMode(mode);
    persistMode(mode);
  }, [mode]);

  const cycle = (): void => {
    setMode((m) => (m === 'auto' ? 'light' : m === 'light' ? 'dark' : 'auto'));
  };

  const title =
    mode === 'auto'
      ? 'Theme: auto (follows system) — click for light'
      : mode === 'light'
        ? 'Theme: light — click for dark'
        : 'Theme: dark — click to follow system';

  return (
    <footer className="footer">
      <div className="footer-links">
        <Hint content="GitHub">
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            <GitHubIcon />
            <span>GitHub</span>
          </a>
        </Hint>
        <span className="footer-sep">·</span>
        <Hint content="Slava Abakumov">
          <a href="https://ovirium.com" target="_blank" rel="noopener noreferrer">
            Slava Abakumov
          </a>
        </Hint>
      </div>
      <Hint content={title}>
        <button type="button" className="theme-toggle" onClick={cycle} aria-label={title}>
          {mode === 'light' ? <SunIcon /> : mode === 'dark' ? <MoonIcon /> : <MonitorIcon />}
        </button>
      </Hint>
    </footer>
  );
}

const strokeProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function SunIcon(): JSX.Element {
  return (
    <svg {...strokeProps}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="M4.93 4.93l1.41 1.41" />
      <path d="M17.66 17.66l1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="M6.34 17.66l-1.41 1.41" />
      <path d="M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon(): JSX.Element {
  return (
    <svg {...strokeProps}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function MonitorIcon(): JSX.Element {
  return (
    <svg {...strokeProps}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function GitHubIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3" />
    </svg>
  );
}
