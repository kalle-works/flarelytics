# Ohjeet seuraavalle sessiolle — Phase 0.5 (Kiiru-pilotti)

Status: **Phase 0 livessä tuotannossa 2026-05-08.** Schemat lukittu, baseline mitattu, infrastruktuuri provisioitu, käyttäytyminen identtinen v0:n kanssa. Valmis aloittamaan Phase 0.5:n Kiiru-pilotin.

---

## Lue ensin (tässä järjestyksessä)

1. **`packages/worker/CLAUDE.md`** — projektin konventiot (suomi, conventional commits, älä mergea mainiin ilman lupaa)
2. **`packages/worker/MIGRATION_PLAN.md`** — Single Source of Truth. Erityisesti:
   - §0 lukitut päätökset (12 kpl)
   - §3 v1-skeemat **byte-cap-sarakkeineen** (lukittu §9 Task A:n mittauksilla)
   - §4 Phase 0.5 -kuvaus (rivi 386–400)
   - §6 cutover-kriteerit (Phase 0.5 → 1 erityisesti — usefulness gate)
   - §9 Tasks A + B (lukitut mittaukset, **älä mittaa uudelleen**)
   - §11 Phase 0.5 -testivaatimukset (~25 testikohtaa)
   - §13 worktree-parallelization (mikä riippuu mistä)
   - §15–§16 design-speksit Distribution Loop -näkymälle
3. **`packages/worker/src/index.ts`** — nykyinen v0-koodi. Phase 0:n bindings ovat olemassa (`PAGEVIEW_EVENTS`, `ENGAGEMENT_EVENTS`, `SHARE_EVENTS`, `BOT_EVENTS`, `PERFORMANCE_EVENTS`, `CUSTOM_EVENTS`, `DIMENSIONS`, `ENRICH_QUEUE`, `ARCHIVE`) mutta käyttämättä.
4. **`packages/tracker/src/tracker.ts`** ja `tracker.test.ts` — nykyinen tracker. Phase 0.5 lisää `canonical_url`-kentän payloadiin.
5. **Approved-mockupit** (Distribution Loop / Content Performance / Article Scorecard) — `~/.gstack/projects/kalle-works-flarelytics/designs/` (variant-A, variant-A, variant-C). Implementer lukee ne `Read`-toolilla kun rakennat näkymää.

---

## Mitä on jo varmistettu — älä toista

| Asia | Tulos | Lukittu |
|---|---|---|
| AE 16 KB total blob limit | ✓ Empiirisesti 15.5 KB rivit menevät pixel-perfect | §9 Task A |
| AE 96B index ceiling (uusi löydös) | site_id slicetään 64B:hen kaikissa v1-datasetissä | §9 Task A4 |
| /track p99 baseline | 18.18 ms (Helsinki → CF edge, 100 RPS × 5 min) | §9 Task B |
| Phase 1 dual-emit risk gate | p99 ≤ 23.63 ms (×1.30) | §6 |
| Per-blob byte-budjetit | Kuusi schema-taulua §3:ssa | §3 |
| Visitor hash-pituus | 16 hex (8B), v0:lla aina ollut tämä | §3 |
| /track datapointit/invokaatio | 1 v0 + 1 v1 = 2 (125× headroom) | §9 Task A3 |

Älä uudelleenmittaa näitä; aja k6-skripti vain Phase 1 -dual-emit-mittausta varten **kun /track-koodissa on dual-emit**.

---

## Ensimmäinen tehtävä — kolme rinnakkaista, riippumatonta moduulia

Plan §13 Lane C: nämä eivät riipu /track-muutoksista ja voi tehdä rinnakkain. Kaikki ovat puhdasta logiikkaa, helppoja unit-testata, EI vaadi deployta:

### Tehtävä 1A — Tracker `canonical_url` -emit (Kiiru-only feature flag)

`packages/tracker/src/tracker.ts`:
- Lue `<link rel="canonical">` jos olemassa
- Fallback: `location.href` normalisoituna (lowercase host, strip default port, strip fragment, optional trailing slash)
- Lisää payloadiin `canonical_url`-kenttä
- Feature flag: emit vain jos `data-emit-canonical="true"` tracker-tagissä — Kiiru opt-in (muut sivustot lähettävät ilman canonical_url:ää, worker tekee server-side fallbackin)
- Unit-testit kattamaan: canonical-tagin parsiminen, normalisointi, fallback-polut

Plan §11 Phase 0.5 -testivaatimukset (rivi 631–635):
- "SHA256(canonical_url)[0:12] same input → same hash"
- "Different canonical → different hash"
- "Trailing slash, case, fragment normalization"
- "Tracker payload missing canonical_url → fallback to request URL with `canonical_inferred='1'`"

(Hash-puoli on workerin vastuulla; trackerin vastuulla on emit + normalize.)

### Tehtävä 1B — Referrer resolver -moduuli

`packages/worker/src/referrer/index.ts` (uusi tiedosto, EI vielä kutsuttu /track:sta):
- Funktio `parseReferrer(url: string): { social_platform: string; social_post_id: string }`
- Tukee plan §0 päätös 2A + §11 testivaatimukset:
  - `bsky.app/profile/X/post/Y` → `{platform: 'bluesky', post_id: 'X/post/Y'}`
  - `l.facebook.com/?u=...&story_fbid=N` → `{platform: 'facebook', post_id: 'N'}`
  - `news.ycombinator.com/item?id=X` → `{platform: 'hn', post_id: 'X'}`
  - `reddit.com/r/X/comments/Y/Z` → `{platform: 'reddit', post_id: 'Y'}`
  - `t.co/...` → `{platform: 'x', post_id: ''}` (2A: ei HTTP-resolveä)
  - Mastodon any-instance → `{platform: 'mastodon', post_id: 'instance/post'}`
  - Tuntematon → `{platform: '', post_id: ''}`
- Truncation: post_id ≤ 80 tavua (§3 cap)
- Vitest-testit kunkin platformin happy path + edge case

### Tehtävä 1C — Bot/AI classifier -moduuli

`packages/worker/src/classifier/index.ts` (uusi tiedosto):
- Funktio `classifyUserAgent(ua: string): { bot_class: 'human'|'search-bot'|'ai-crawler'|'unknown-bot', ai_actor: string }`
- Hyödyntää nykyistä `DEFAULT_BOT_PATTERNS`-listaa (`packages/worker/src/index.ts:52-58`) mutta laajentaa sen AI-actor-tunnistukseen:
  - ChatGPT-User → `{bot_class: 'ai-crawler', ai_actor: 'chatgpt'}`
  - Claude-Web / ClaudeBot → `{ai_actor: 'claude-web'}`
  - PerplexityBot → `{ai_actor: 'perplexity'}`
  - Gemini → `{ai_actor: 'gemini'}`
  - BingAI → `{ai_actor: 'bingai'}`
  - Googlebot/Bingbot → `{bot_class: 'search-bot', ai_actor: ''}`
  - Vakio human → `{bot_class: 'human', ai_actor: ''}`
- Tuntematon AI-pattern → `{bot_class: 'ai-crawler', ai_actor: 'unknown-ai'}`
- Tuntematon bot → `{bot_class: 'unknown-bot', ai_actor: ''}`
- Caps: bot_class ≤ 16B, ai_actor ≤ 32B (§3)

**Sano käyttäjälle ennen koodaamista:** Kerro kumman tehtävän aiot tehdä ensin tai aiotko rinnakkaisia worktree-instancesseja. Kysy vahvistus tehtävän scopelle ennen kuin kirjoitat enempää kuin 50 riviä koodia. Älä aloita aiheesta poikkeavasti.

---

## Mitä saa varmasti tehdä

- Lukea kaikki tiedostot reposta
- Kirjoittaa uutta lähdekoodia `packages/worker/src/referrer/`, `packages/worker/src/classifier/`, `packages/tracker/src/`
- Lisätä unit-testejä vitest-formaatissa
- Ajaa `npm test` `packages/worker/` ja `packages/tracker/` -juuressa
- Committaa + pushata `design/migration-plan` -branchille
- Käyttää `Edit`-toolia muokkaamaan olemassa olevia tiedostoja MIKÄLI muutos on tehtävän scopeissa

## Mitä EI saa ilman lupaa

- Mergetä mainiin (CLAUDE.md vaatii `/review` ennen mergea + erillisen luvan)
- Deployata Cloudflareen (`wrangler deploy`) — Phase 0.5:n Kiiru-pilotin kytkeminen tuotantoon vaatii Kallen erillisen luvan
- Lisätä /track-koodiin v1-kirjoituksia ennen kuin referrer + classifier -moduulit ovat unit-testattu erikseen
- Käynnistää queue consumer -workeria (oma deploy, oma scope-keskustelu)
- Aloittaa Distribution Loop -näkymän rakentamista ennen kuin v1-queryt ovat olemassa ja v1-data virtaa Kiirun /track:sta

---

## Skills jotka kannattaa käyttää

| Skill | Milloin |
|---|---|
| `/investigate` | Jos kohtaat odottamattoman virheen (ennen kuin kosket koodiin) |
| `/codex challenge` | Kun olet luonnos uuden moduulin julkista API:a tai SQL-templatea ennen committia |
| `/codex review` | Diff-tason 2nd opinion ennen pushia |
| `/review` | Ennen jokaista mergea — CLAUDE.md vaatii |
| `/ship` | Kun branch on valmis mergetä; ajaa testit + diff-reviewn ennen kuin avaa PR:n |
| `/qa` | Jos lisäät dashboard-näkymän — kattava QA + bug-fix loop |

**ÄLÄ** käytä:
- `/design-shotgun` (mockupit ovat jo §15:ssä)
- `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/plan-devex-review` (kaikki ajettu, lukittu)
- `/office-hours` (alkuperäinen tarve on lukittu plan §0:ssa)

---

## Tärkeimmät tiedostot

| Polku | Mitä on |
|---|---|
| `packages/worker/MIGRATION_PLAN.md` | SSOT — kaikki päätökset |
| `packages/worker/src/index.ts` | Tuotannon worker (v0 + Phase 0 bindings) |
| `packages/worker/src/index.test.ts` | 25 unit-testiä — säilyy 100% pass aina |
| `packages/worker/migrations/0001_initial.sql` | D1 schema (applied to remote) |
| `packages/worker/wrangler.toml` | (gitignored) tuotannon konfiguraatio resurssi-ID:illä |
| `packages/worker/wrangler.toml.example` | Committoitu blueprint self-hostereille |
| `packages/worker/perf/baseline-track.js` | k6-skripti — uudelleenajettavissa Phase 1 -mittausta varten |
| `packages/worker/test-ae-limits/` | §9 Task A:n harnessi (deletoitu CF:stä, source jää) |
| `packages/tracker/src/tracker.ts` | Vanilla JS tracker (vähimmäismuutoksia mieluiten) |

## Tuotannon resurssit (älä luo uusia)

| Resurssi | Tunniste |
|---|---|
| CF account | `4afa9a2ef256ff7f1cec9ed91ff03561` |
| Worker (prod) | `flarelytics` (https://flarelytics.kl100.workers.dev) |
| KV namespace | `d332c72d6ea64643a1ed43ee732814b5` (SITE_CONFIG) |
| D1 database | `7e55f9f3-700e-466c-95d5-cf267e3fed67` (`flarelytics-dimensions`) |
| Queue | `flarelytics-enrich` (id `864e5c89a3a647e9ae53b30279a7804d`) |
| DLQ | `flarelytics-enrich-dlq` (id `9b7172d6f73f418186954467b7a896f6`) |
| R2 bucket | `flarelytics-archive` |
| AE datasets (legacy) | `flarelytics` (jatkaa kirjoitusta Phase 4 saakka) |
| AE datasets (v1) | `flarelytics_pageview_v1`, `_engagement_v1`, `_share_v1`, `_bot_v1`, `_performance_v1`, `_custom_v1` |

---

## Tracker payload -kontrakti (lukittu §3)

Phase 0.5:n `/track` POST body täytyy hyväksyä molemmat:

**v0 (legacy, jatkuu):**
```json
{ "event": "pageview", "path": "/...", "referrer": "...", "utm_source": "..." }
```

**v1 (uusi, opt-in `data-emit-canonical`):**
```json
{
  "event": "pageview",
  "path": "/...",
  "canonical_url": "https://kiiru.fi/a/...",
  "referrer": "...",
  "utm_source": "..."
}
```

Worker server-side:
- Jos `canonical_url` puuttuu → `canonical_inferred='1'`, hash request URL:istä
- Jos olemassa → `canonical_inferred=''`, hash siitä
- `canonical_url_hash` = `SHA-256(canonical_url)[0:12]` molemmissa tapauksissa

---

## Testikäytännöt (CLAUDE.md vaatii)

- Jokaisen featuren jälkeen: `npm test` (worker + tracker)
- E2E-testit Phase 0.5:n end-to-end -kululle: synthetic article → outbound share → return-pageview → loop view (§11 rivi 656)
- Älä mockaa Cloudflaren bindingseja AE-emit-testeissä; käytä `vi.fn()` -spya kuten nykyinen `index.test.ts:7-12`
- Pre-existing TS-virheet `index.test.ts:24,30,45,58,69,70,86`: `worker.fetch(req, env, ctx)` kutsuu 3 argumentilla mutta signature ottaa 2. Vitest hyväksyy runtimeen. Älä korjaa Phase 0.5:n osana — vaatii oman commitin.

---

## Ensimmäinen viesti käyttäjälle

Sano näin:

> "Aloitan Phase 0.5:n. Olen lukenut MIGRATION_PLAN.md §:t 0, 3, 4, 6, 9 (A+B), 11, 13, 15, 16. Nykyiset Phase 0 bindings ovat valmiit, perustyö ennen /track-dual-emitiä on kolme rinnakkaista moduulia: (1A) tracker canonical_url -emit, (1B) referrer resolver, (1C) bot/AI classifier. Aloitan **[VALITSE 1A | 1B | 1C | rinnakkaisena worktreessa]**, kirjoitan ensin julkisen API:n + unit-testit, ajan testit, ja palaan sinulle 2nd opinion -tarkistusta varten ennen commitia. Vahvistatko suunnan?"

Odota vahvistus ennen kuin alat kirjoittaa lähdekoodia (yli 50 rivin scope).
