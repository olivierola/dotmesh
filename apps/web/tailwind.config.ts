import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'sans-serif',
        ],
      },
      colors: {
        // Gold accent — chosen for warmth + premium feel on dark bg.
        accent: {
          DEFAULT: '#f5b301',
          50: '#fff9e6',
          100: '#ffefb3',
          400: '#facc15',
          500: '#f5b301',
          600: '#d49500',
          700: '#a87500',
          hover: '#e0a300',
        },
        // ----- Semantic tokens used by the Claude-style chat input -----
        // Mapped to our dark theme (Mesh is dark-only for now).
        bg: {
          0: '#0a0a0a', // neutral-950 — page bg
          100: '#171717', // neutral-900 — card bg
          200: '#1f1f1f', // between 900 and 800 — hover bg
          300: '#262626', // neutral-800 — borders
        },
        text: {
          100: '#f5f5f5', // primary
          200: '#e5e5e5',
          300: '#a3a3a3', // secondary
          400: '#737373', // muted
          500: '#525252', // faint
        },
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
      },
    },
  },
  plugins: [],
};
export default config;
