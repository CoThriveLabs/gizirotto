import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'gizirotto-blue-50': '#EEF4FA',
        'gizirotto-blue-100': '#E0EBF5',
        'gizirotto-blue-200': '#B8D4E8',
        'gizirotto-blue-500': '#5B89C2',
        'gizirotto-blue-700': '#3E6FAA',
        'gizirotto-blue-800': '#2D5A8C',
        'gizirotto-blue-900': '#1E4470',
        'accent-warm': '#E8A87C',
      },
      fontFamily: {
        sans: ['"Noto Sans JP"', '"Hiragino Sans"', 'sans-serif'],
        serif: ['"Noto Serif JP"', 'serif'],
      },
    },
  },
  plugins: [],
}
export default config
