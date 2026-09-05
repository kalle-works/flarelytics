/** GET /tracker.js — serves the built @flarelytics/tracker IIFE bundle. */

// wrangler.toml.example declares a text-module rule (`[[rules]] type =
// "Text" globs = ["**/*.iife.js"]`) so this import resolves to the file's
// raw source at deploy time; vitest.config.ts's raw-text plugin does the
// same for tests. The `*.iife.js` ambient module type lives in
// text-modules.d.ts since TypeScript's `bundler` moduleResolution only
// honors wildcard module augmentations declared in a .d.ts file.
import trackerScript from '../../tracker/dist/tracker.iife.js';

export function handleTrackerJs(request: Request): Response {
  const url = new URL(request.url);
  const endpoint = `${url.protocol}//${url.host}`;
  // The tracker source defines a `__ENDPOINT__` placeholder that resolves to
  // "no endpoint configured" unless replaced — substituting the worker's own
  // origin here means `<script src=".../tracker.js">` with no data-endpoint
  // attribute still auto-inits against the worker that served it, while an
  // explicit data-endpoint attribute on the script tag still overrides it.
  const script = trackerScript.replace(/__ENDPOINT__/g, endpoint);
  return new Response(script, {
    headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=86400' },
  });
}
