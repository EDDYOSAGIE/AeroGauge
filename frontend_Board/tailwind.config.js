/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['sans-serif','Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', ],
        display: ['Playfair Display', 'Georgia', 'Times New Roman', 'serif'],
      },
    },
  },
  plugins: [],
}
