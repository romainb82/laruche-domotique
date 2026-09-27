/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      // Tokens semantiques. Les valeurs vivent dans style.css.
      colors: {
        ground: 'rgb(var(--c-ground) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        raised: 'rgb(var(--c-raised) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        ink: 'rgb(var(--c-ink) / <alpha-value>)',
        soft: 'rgb(var(--c-soft) / <alpha-value>)',
        faint: 'rgb(var(--c-faint) / <alpha-value>)',
        // La lumiere allumee. Tout le vocabulaire visuel tourne autour.
        glow: 'rgb(var(--c-glow) / <alpha-value>)',
        'glow-deep': 'rgb(var(--c-glow-deep) / <alpha-value>)',
        'warn-deep': 'rgb(var(--c-warn-deep) / <alpha-value>)',
        // Le jour qui entre : volets, ouvrants, position.
        jour: 'rgb(var(--c-jour) / <alpha-value>)',
        'jour-deep': 'rgb(var(--c-jour-deep) / <alpha-value>)',
        ok: 'rgb(var(--c-ok) / <alpha-value>)',
        warn: 'rgb(var(--c-warn) / <alpha-value>)',
        crit: 'rgb(var(--c-crit) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['ui-sans-serif', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SF Mono', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: { xl: '0.875rem', '2xl': '1.125rem', '3xl': '1.5rem' },
      boxShadow: {
        // La lueur d'une piece allumee.
        lit: '0 0 0 1px rgb(var(--c-glow) / 0.35), 0 6px 28px -6px rgb(var(--c-glow) / 0.4)',
        card: '0 1px 2px rgb(0 0 0 / 0.04), 0 4px 16px -8px rgb(0 0 0 / 0.12)',
      },
      transitionTimingFunction: { swift: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    },
  },
  plugins: [],
};
