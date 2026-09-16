import React, { useEffect, useState, useCallback } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { Button } from './ui/button';

const STORAGE_KEY = 'kullina_theme';
const THEMES = ['light', 'dark', 'system'];

const applyTheme = (theme) => {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  if (theme === 'system') {
    root.removeAttribute('data-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) root.classList.add('dark');
    else root.classList.add('light');
  } else {
    root.setAttribute('data-theme', theme);
    root.classList.add(theme);
  }
};

export const useTheme = () => {
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') return 'system';
    return localStorage.getItem(STORAGE_KEY) || 'system';
  });

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) {}
  }, [theme]);

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const cycle = useCallback(() => {
    setTheme(t => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]);
  }, []);

  return { theme, setTheme, cycle };
};

export const ThemeToggle = ({ size = 'icon', variant = 'ghost', className = '' }) => {
  const { theme, cycle } = useTheme();
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  const label = theme === 'light' ? 'Light theme' : theme === 'dark' ? 'Dark theme' : 'System theme';

  return (
    <Button
      onClick={cycle}
      variant={variant}
      size={size}
      className={className}
      title={label}
      aria-label={`${label}. Click to switch.`}
    >
      <Icon size={18} />
    </Button>
  );
};
