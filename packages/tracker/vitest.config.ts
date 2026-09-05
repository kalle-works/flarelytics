import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // vitest's jsdom default (http://localhost:3000/) would trip the
    // tracker's localhost-exclusion guard for every test that doesn't
    // explicitly stub location — use a real-looking origin instead and let
    // the localhost tests stub location to a local host themselves.
    environmentOptions: {
      jsdom: { url: 'https://example.com/' },
    },
  },
});
