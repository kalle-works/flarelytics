/**
 * Org→site ownership store with DNS-TXT domain verification.
 *
 * A hostname may belong to exactly one organization, and an org may only claim
 * a hostname it provably controls. This is the authorization layer above
 * Analytics Engine: AE rows stay scoped by `blob10` (hostname); this decides
 * which hostnames a given org may pass as `?site=`. Without verification a user
 * could add another tenant's hostname to their own org and read its analytics.
 *
 * KV layout (all in SITE_CONFIG):
 *   org:<orgId>:sites        → [{hostname,label}]   verified sites an org can query
 *   site_owner:<hostname>    → orgId                 global exclusive owner
 *   site_claim:<orgId>:<host>→ token                 pending (unverified) claim
 *   allowed_origins          → string[]              global /track CORS list
 *
 * Verification: the claimer adds a DNS TXT record at `_flarelytics.<hostname>`
 * containing the claim token; the worker confirms it via DNS-over-HTTPS before
 * granting ownership.
 */

import { base64urlEncode, randomBytes } from './crypto';

const GLOBAL_ORIGINS_KEY = 'allowed_origins';
const CLAIM_TTL_SECS = 30 * 24 * 60 * 60; // pending claims expire after 30 days
const TXT_RECORD_NAME = (hostname: string) => `_flarelytics.${hostname}`;
const TXT_PREFIX = 'flarelytics-site-verification=';
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

export interface OrgSite {
  hostname: string;
  label: string;
}

export interface PendingClaim {
  pending: true;
  hostname: string;
  verification: { type: 'dns-txt'; name: string; value: string };
}

function orgKey(orgId: string): string { return `org:${orgId}:sites`; }
function ownerKey(hostname: string): string { return `site_owner:${hostname}`; }
function claimKey(orgId: string, hostname: string): string { return `site_claim:${orgId}:${hostname}`; }

/** List the verified sites an org can query. Empty array when none. */
export async function listSites(kv: KVNamespace, orgId: string): Promise<OrgSite[]> {
  if (!kv || !orgId) return [];
  const raw = await kv.get(orgKey(orgId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The org that owns a hostname, or null if unclaimed. */
export async function siteOwner(kv: KVNamespace, hostname: string): Promise<string | null> {
  if (!kv || !hostname) return null;
  return kv.get(ownerKey(hostname));
}

/**
 * Begin (or resume) a claim on a hostname.
 * - Already owned by this org → adds to the org's site list and returns OrgSite[].
 * - Owned by another org → throws SiteConflictError.
 * - Otherwise → returns a PendingClaim with the DNS TXT record to add. The token
 *   is stable across retries so the displayed record doesn't change on reload.
 */
export async function claimSite(
  kv: KVNamespace, orgId: string, hostname: string, label?: string,
): Promise<OrgSite[] | PendingClaim> {
  const owner = await siteOwner(kv, hostname);
  if (owner && owner !== orgId) throw new SiteConflictError(hostname);
  if (owner === orgId) {
    return ensureInList(kv, orgId, hostname, label);
  }

  let token = await kv.get(claimKey(orgId, hostname));
  if (!token) {
    token = base64urlEncode(randomBytes(18));
    await kv.put(claimKey(orgId, hostname), token, { expirationTtl: CLAIM_TTL_SECS });
  }
  return {
    pending: true,
    hostname,
    verification: { type: 'dns-txt', name: TXT_RECORD_NAME(hostname), value: TXT_PREFIX + token },
  };
}

/**
 * Verify a pending claim by checking the DNS TXT record. On success the org
 * becomes the exclusive owner, the site is added to its list, and the origin is
 * unioned into the global /track CORS allowlist. Returns the updated site list.
 * Throws SiteConflictError (taken), NoClaimError (nothing pending), or
 * VerificationError (TXT record missing/mismatched).
 */
export async function verifySite(
  kv: KVNamespace, orgId: string, hostname: string, label?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OrgSite[]> {
  const owner = await siteOwner(kv, hostname);
  if (owner && owner !== orgId) throw new SiteConflictError(hostname);
  if (owner === orgId) return ensureInList(kv, orgId, hostname, label);

  const token = await kv.get(claimKey(orgId, hostname));
  if (!token) throw new NoClaimError(hostname);

  const ok = await dnsTxtContains(hostname, TXT_PREFIX + token, fetchImpl);
  if (!ok) throw new VerificationError(hostname, TXT_RECORD_NAME(hostname), TXT_PREFIX + token);

  // Re-check ownership right before committing to narrow the claim race.
  const ownerNow = await siteOwner(kv, hostname);
  if (ownerNow && ownerNow !== orgId) throw new SiteConflictError(hostname);

  await kv.put(ownerKey(hostname), orgId);
  await kv.delete(claimKey(orgId, hostname));
  const sites = await ensureInList(kv, orgId, hostname, label);
  await addGlobalOrigin(kv, hostname);
  return sites;
}

/**
 * Remove a site from an org and release its global ownership + any pending
 * claim. When this org is the current owner, also releases the hostname's
 * origin from the global /track CORS allowlist that verifySite granted —
 * otherwise /track keeps accepting (and billing) events for a site no org
 * can query anymore.
 */
export async function removeSite(kv: KVNamespace, orgId: string, hostname: string): Promise<OrgSite[]> {
  const sites = (await listSites(kv, orgId)).filter((s) => s.hostname !== hostname);
  await kv.put(orgKey(orgId), JSON.stringify(sites));
  const owner = await siteOwner(kv, hostname);
  if (owner === orgId) {
    await kv.delete(ownerKey(hostname));
    await removeGlobalOrigin(kv, hostname);
  }
  await kv.delete(claimKey(orgId, hostname));
  return sites;
}

async function ensureInList(kv: KVNamespace, orgId: string, hostname: string, label?: string): Promise<OrgSite[]> {
  const sites = await listSites(kv, orgId);
  if (!sites.some((s) => s.hostname === hostname)) {
    sites.push({ hostname, label: label || hostname });
    await kv.put(orgKey(orgId), JSON.stringify(sites));
  }
  return sites;
}

/** DNS-over-HTTPS TXT lookup at `_flarelytics.<hostname>`; true if any record contains `expected`. */
async function dnsTxtContains(hostname: string, expected: string, fetchImpl: typeof fetch): Promise<boolean> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(TXT_RECORD_NAME(hostname))}&type=TXT`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/dns-json' } });
  } catch {
    return false;
  }
  if (!res.ok) return false;
  let data: { Answer?: Array<{ data?: string }> };
  try { data = await res.json(); } catch { return false; }
  const answers = data.Answer || [];
  return answers.some((a) => typeof a.data === 'string' && a.data.replace(/"/g, '').includes(expected));
}

/** Union an https origin for `hostname` into the global CORS allowlist used by /track. */
async function addGlobalOrigin(kv: KVNamespace, hostname: string): Promise<void> {
  const origin = `https://${hostname}`;
  const raw = await kv.get(GLOBAL_ORIGINS_KEY);
  let origins: string[] = [];
  if (raw) {
    try { origins = JSON.parse(raw); } catch { origins = []; }
  }
  if (!Array.isArray(origins)) origins = [];
  if (!origins.includes(origin)) {
    origins.push(origin);
    await kv.put(GLOBAL_ORIGINS_KEY, JSON.stringify(origins));
  }
}

/** Remove the https origin for `hostname` from the global CORS allowlist (inverse of addGlobalOrigin). */
async function removeGlobalOrigin(kv: KVNamespace, hostname: string): Promise<void> {
  const origin = `https://${hostname}`;
  const raw = await kv.get(GLOBAL_ORIGINS_KEY);
  if (!raw) return;
  let origins: string[];
  try { origins = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(origins) || !origins.includes(origin)) return;
  await kv.put(GLOBAL_ORIGINS_KEY, JSON.stringify(origins.filter((o) => o !== origin)));
}

export class SiteConflictError extends Error {
  constructor(public hostname: string) { super(`Hostname ${hostname} is owned by another organization`); }
}
export class NoClaimError extends Error {
  constructor(public hostname: string) { super(`No pending claim for ${hostname}`); }
}
export class VerificationError extends Error {
  constructor(public hostname: string, public recordName: string, public recordValue: string) {
    super(`DNS TXT verification failed for ${hostname}`);
  }
}
