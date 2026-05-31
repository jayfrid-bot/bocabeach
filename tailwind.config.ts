import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ocean: {
          50: "#eef9ff",
          100: "#d9f1ff",
          200: "#bce7ff",
          300: "#8ed8ff",
          400: "#59c1ff",
          500: "#32a4ff",
          600: "#1b85f5",
          700: "#146de1",
          800: "#1758b6",
          900: "#194d8f",
          950: "#142f57",
        },
      },
    },
  },
  plugins: [],
};

export default config;
