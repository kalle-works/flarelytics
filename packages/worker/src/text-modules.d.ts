/**
 * Ambient module type for the raw-text `*.iife.js` import used by
 * tracker-script.ts. Matches wrangler's `[[rules]] type = "Text"` module
 * rule (wrangler.toml.example) and vitest.config.ts's matching raw-text
 * plugin — both hand back the file's contents as a plain string.
 */
declare module '*.iife.js' {
  const source: string;
  export default source;
}
