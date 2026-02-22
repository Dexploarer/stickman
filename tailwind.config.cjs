/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./web/index.html", "./web/app.js"],
  theme: {
    extend: {
      colors: {
        pod: {
          950: "#04070d",
          900: "#0a1323",
          800: "#12203a",
          700: "#1c3358",
          600: "#31558c",
          500: "#4c7fd0",
          400: "#7aa8ed",
          300: "#b2cdf8",
        },
      },
      fontFamily: {
        sans: ["Manrope", "Anek Latin", "system-ui", "sans-serif"],
        display: ["Outfit", "Manrope", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "IBM Plex Mono", "SFMono-Regular", "monospace"],
      },
      boxShadow: {
        "pod-panel": "0 20px 48px rgba(6, 12, 24, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.06)",
      },
    },
  },
  corePlugins: {
    preflight: false,
  },
};

