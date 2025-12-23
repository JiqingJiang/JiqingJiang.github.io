/** @type {import('tailwindcss').Config} */
const defaultTheme = require("tailwindcss/defaultTheme")
module.exports = {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue,mjs}"],
  darkMode: "class", // allows toggling dark mode manually
  theme: {
    extend: {
      fontFamily: {
        sans: ["Roboto", "sans-serif", ...defaultTheme.fontFamily.sans],
      },
      colors: {
        // 告诉 Tailwind 这些是有效的颜色
        primary: "rgb(var(--primary) / <alpha-value>)",
        "link-underline": "rgb(var(--link-underline) / <alpha-value>)",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
  // 添加 safelist 确保这些类不会被清除
  safelist: [
    "link",
    "text-[var(--primary)]",
    "decoration-[var(--link-underline)]",
    "decoration-transparent",
  ],
}
