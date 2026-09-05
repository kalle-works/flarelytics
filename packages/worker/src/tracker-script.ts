/** GET /tracker.js — serves the built @flarelytics/tracker IIFE bundle. */

// The tracker build (packages/tracker/scripts/emit-module.mjs) wraps the
// minified IIFE bundle in an ES module that default-exports it as a string,
// so the browser script travels through wrangler's bundler as plain data and
// needs no text-module rule in wrangler.toml.
import trackerScript from '../../tracker/dist/tracker-script.mjs';

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
