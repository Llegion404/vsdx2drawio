import { defineConfig } from 'vite';

// GitHub Pages serves the site under /vsdx2drawio/ — CI sets VITE_BASE.
// Local dev/build default to the root.
export default defineConfig({
  base: process.env.VITE_BASE || '/',
});
