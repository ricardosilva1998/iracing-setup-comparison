// bridge-app does not use PostCSS/Tailwind.
// This file exists to prevent Vite from walking up to the repo-root postcss.config.mjs
// (which requires @tailwindcss/postcss — a Next.js web-app dependency not present here).
export default {};
