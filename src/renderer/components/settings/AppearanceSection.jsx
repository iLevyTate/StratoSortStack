import React from 'react';
import Button from '../ui/Button';
import { Text } from '../ui/Typography';
import SettingsCard from './SettingsCard';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { setSelectedTheme } from '../../store/slices/uiSlice';

/**
 * Theme picker. Renderer-only visual preference held in ui.selectedTheme and
 * applied as a data-theme attribute on <html> (see App.js). The swatch colors
 * are intentionally hard-coded literals here — they are a static legend of each
 * palette, not live theme tokens (which would all read as the active theme).
 */
const THEME_OPTIONS = [
  {
    value: 'primary',
    label: 'Primary',
    description: 'The signature deep-navy StratoSort profile.',
    surface: '#1a2e3e',
    accent: '#3ba0c0'
  },
  {
    value: 'light',
    label: 'Light',
    description: 'A soft off-white surface with StratoSort accents.',
    surface: '#eef2f6',
    accent: '#1f86a8'
  },
  {
    value: 'dark',
    label: 'Dark',
    description: 'A deep charcoal palette that is easy on the eyes.',
    surface: '#14171a',
    accent: '#46b0d0'
  }
];

function ThemeSwatch({ surface, accent }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-4 w-4 rounded-full border border-border-strong"
      style={{ background: `linear-gradient(135deg, ${surface} 0 50%, ${accent} 50% 100%)` }}
    />
  );
}

function AppearanceSection() {
  const dispatch = useAppDispatch();
  const selectedTheme = useAppSelector((state) => state.ui.selectedTheme);
  const activeTheme =
    THEME_OPTIONS.find((option) => option.value === selectedTheme) ?? THEME_OPTIONS[0];

  return (
    <SettingsCard
      title="Appearance"
      description="Choose the color palette for the app. Your choice is remembered across sessions."
    >
      <div
        className="flex flex-col gap-compact sm:flex-row"
        role="group"
        aria-label="App color theme"
      >
        {THEME_OPTIONS.map((option) => {
          const isActive = option.value === activeTheme.value;
          return (
            <Button
              key={option.value}
              type="button"
              variant={isActive ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => dispatch(setSelectedTheme(option.value))}
              aria-pressed={isActive}
              leftIcon={<ThemeSwatch surface={option.surface} accent={option.accent} />}
              className="w-full justify-start sm:w-auto"
            >
              {option.label}
            </Button>
          );
        })}
      </div>
      <Text variant="small" className="text-system-gray-600">
        {activeTheme.description}
      </Text>
    </SettingsCard>
  );
}

export default AppearanceSection;
