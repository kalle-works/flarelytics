import { defineConfig } from 'astro/config';

export default defineConfig({
  // Astro 7 defaults to JSX whitespace rules, which drop the spaces between inline elements.
  compressHTML: true,
  output: 'static',
});
