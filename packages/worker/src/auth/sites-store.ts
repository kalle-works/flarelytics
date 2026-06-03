/**
 * Org→site ownership store. Holds, per organization, the set of site hostnames
 * that org is allowed to query. This is the authorization layer above Analytics
 * Engine: AE rows stay scoped by `blob10` (hostname); this decides which
 * hostnames a given org may pass as `?site=`.
 *
 * Storage is KV (`org:<orgId>:sites`). All access goes through this module so a
 * future move to D1 (for audit trails / relational queries) is contained here.
 */

const GLOBAL_ORIGINS_KEY = 'allowed_origins';

export interface OrgSite {
  hostname: string;
  label: string;
}

function orgKey(orgId: string): string {
  return `org:${orgId}:sites`;
}

/** List the sites owned by an org. Empty array when none configured. */
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

/**
 * Add a site to an org. Idempotent on hostname. Also unions the hostname's
 * https origin into the global `allowed_origins` list so `/track` keeps
 * accepting events from it.
 */
export async function addSite(kv: KVNamespace, orgId: string, hostname: string, label?: string): Promise<OrgSite[]> {
  const sites = await listSites(kv, orgId);
  if (!sites.some((s) => s.hostname === hostname)) {
    sites.push({ hostname, label: label || hostname });
    await kv.put(orgKey(orgId), JSON.stringify(sites));
  }
  await addGlobalOrigin(kv, hostname);
  return sites;
}

/** Remove a site from an org. Does not touch the global origins list (other orgs may share a hostname). */
export async function removeSite(kv: KVNamespace, orgId: string, hostname: string): Promise<OrgSite[]> {
  const sites = (await listSites(kv, orgId)).filter((s) => s.hostname !== hostname);
  await kv.put(orgKey(orgId), JSON.stringify(sites));
  return sites;
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
