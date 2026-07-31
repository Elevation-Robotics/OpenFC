/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Match-screen palette (see spec §9.2.1)
        match: {
          idle: '#0d1117',
          auto: '#0d1f4d',
          autoText: '#93c5fd',
          driver: '#0d2e14',
          driverText: '#86efac',
          stopped: '#2e0d0d',
          stoppedText: '#fca5a5',
          done: '#1a1a2e',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
