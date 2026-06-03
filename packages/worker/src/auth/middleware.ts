/**
 * Authorization helpers over a verified session. Single source of truth for
 * org scoping, role checks, site-access checks, and the same-origin (CSRF)
 * guard for mutating requests.
 *
 * Ported from the helpparibotti worker (worker/lib/auth-middleware.js).
 * `assertBotOwner` becomes `assertSiteAccess` — the flarelytics resource is a
 * site (hostname) rather than a bot.
 */

import type { SessionPayload } from './session';
import { listSites } from './sites-store';

/**
 * Active workspace (active_org) id — the single source of truth for org
 * scoping. The synthetic personal workspace uses the user's `sub` as its id,
 * so there is no dual-read and no cross-tenant leak.
 */
export function activeOrgId(session: SessionPayload): string | null {
  return session.active_org || session.sub || null;
}

/** Role in the active workspace from the session's orgs list (owner|admin|member|null). */
export function activeRole(session: SessionPayload): string | null {
  const id = activeOrgId(session);
  const org = (session.orgs || []).find((o) => o.id === id);
  return org ? org.role : null;
}

/** owner/admin may manage sites and settings. */
export function canManage(session: SessionPayload): boolean {
  return ['owner', 'admin'].includes(activeRole(session) ?? '');
}

/** Any member (incl. member) may view analytics. */
export function canView(session: SessionPayload): boolean {
  return activeRole(session) != null;
}

/** Throws a 403 Response if the active role is not in the allowed set. */
export function requireOrgRole(session: SessionPayload, roles: string[]): void {
  if (!roles.includes(activeRole(session) ?? '')) {
    throw new Response(JSON.stringify({ error: 'Rooli ei riitä tähän toimintoon' }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    });
  }
}

/** True when the email is in the comma-separated ADMIN_EMAILS superadmin list. */
export function isAdminEmail(adminEmails: string | undefined, email: string | undefined): boolean {
  if (!adminEmails || !email) return false;
  return adminEmails.split(',').map((s) => s.trim()).filter(Boolean).includes(email);
}

/**
 * Confirm the active org owns `site` (hostname). Superadmins (ADMIN_EMAILS) see
 * every site. Throws a 403 Response otherwise. Returns the resolved org id.
 */
export async function assertSiteAccess(
  kv: KVNamespace,
  session: SessionPayload,
  site: string,
  adminEmails?: string,
): Promise<string> {
  const orgId = activeOrgId(session);
  if (isAdminEmail(adminEmails, session.email)) return orgId ?? '';
  if (!orgId) throw forbidden();
  const sites = await listSites(kv, orgId);
  if (!sites.some((s) => s.hostname === site)) throw forbidden();
  return orgId;
}

function forbidden(): Response {
  return new Response(JSON.stringify({ error: 'Forbidden' }), {
    status: 403, headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Same-origin guard for state-changing requests (CSRF defense-in-depth on top
 * of SameSite=Lax). Accepts the request only if its Origin (or Referer) matches
 * one of the allowed dashboard origins. Returns true when allowed.
 */
export function isSameOrigin(request: Request, allowedOrigins: string[]): boolean {
  const origin = request.headers.get('Origin');
  if (origin) return allowedOrigins.includes(origin);
  // Fall back to Referer when Origin is absent (some browsers omit it on GET).
  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      const r = new URL(referer);
      return allowedOrigins.includes(`${r.protocol}//${r.host}`);
    } catch { return false; }
  }
  return false;
}
