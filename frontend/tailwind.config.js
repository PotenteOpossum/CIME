import { cimeColors } from "./src/styles/palette.js";
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: cimeColors,
      fontFamily: {
        sans: ["Outfit", "sans-serif"],
      },
      keyframes: {
        "pop-in": {
          "0%": { transform: "scale(0.4)", opacity: "0" },
          "55%": { transform: "scale(1.2)", opacity: "1" },
          "75%": { transform: "scale(0.95)" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "pop-in": "pop-in 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)",
        "fade-in": "fade-in 0.2s ease-out",
        // One-shot pop entrance immediately followed by a slow ambient pulse, so a newly
        // appeared "New poll" indicator grabs attention right away and keeps a subtle glow.
        "poll-alert":
          "pop-in 0.5s cubic-bezier(0.34, 1.56, 0.64, 1), pulse 2.5s cubic-bezier(0.4, 0, 0.6, 1) 0.5s infinite",
      },
    },
  },
  plugins: [],
};
