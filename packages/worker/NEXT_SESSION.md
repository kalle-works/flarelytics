# Ohjeet seuraavalle sessiolle — Phase 1 (portfolio dual-emit) + Queue consumer

Status: **Phase 0.5 mainissa ja tuotannossa 2026-05-10.** Worker `dbf9c23f` Cloudflaressa, dual-emit aktiivinen Kiirulle, p99 22.80 ms (gate 23.63 ms PASS). §6 cutover-kello käynnissä — Kiirun dual-write ≥99.9 % vaaditaan 7 vrk ennen Phase 1:tä.

---

## Lue ensin (tässä järjestyksessä)

1. **`packages/worker/CLAUDE.md`** — projektin konventiot (suomi, conventional commits, älä mergea mainiin ilman lupaa, älä deployata ilman lupaa)
2. **`packages/worker/MIGRATION_PLAN.md`** — Single Source of Truth. Phase 1:n osalta erityisesti:
   - §4 Phase 1 (rivi 420–426) — full portfolio dual-emit + risk gate
   - §6 cutover-kriteerit (Phase 0.5→1 sarake) — 7 vrk klausuulit
   - §11 Phase 1 -testivaatimukset (rivi 730–734)
   - §13 worktree-parallelization (Lane B vs Lane D vs Lane E -riippuvuudet)
3. **`packages/worker/src/index.ts`** — nykyinen dual-emit, gate `V1_EMIT_SITES = new Set(['kiiru.fi'])` rivillä 28
4. **`packages/worker/src/v1/`** — `canonical.ts` + `emit.ts` (140 testiä, älä riko)

---

## Mitä on jo tuotannossa — älä toista

| Asia | Tulos | Lukittu |
|---|---|---|
| Phase 0 infra (D1, Queues, R2, 6 v1 AE-datasetit) | ✓ provisioitu | wrangler.toml |
| /track p99 baseline | 18.18 ms (Helsinki → CF edge, 100 RPS × 5 min) | §9 Task B |
| Phase 0.5 dual-emit Kiirulle | ✓ live, ctx.waitUntil-mitigaatio | commit `0011c97` |
| Phase 1 dual-emit p99 mittaus | 22.80 ms (gate 23.63, 0.83 ms headroom) | §9 (päivitettävä) |
| Custom event_props_json reject (>1024 B) | ✓ V1_EMIT_SITES-sivuille | commit `0551cfd` |
| Production-deploy | `dbf9c23f` flarelytics worker | 2026-05-10 |

**ÄLÄ uudelleenmittaa baselinea.** Phase 1 -mittaus on jo tehty waitUntil-koodille.

---

## §6 cutover-kello (alkanut 2026-05-10)

Phase 0.5 → 1 vaatii **kaikki** ≥7 vrk:n ajan:

| Kriteeri | Mittauspaikka | Status |
|---|---|---|
| Dual-write success rate ≥ 99.9 % | Kiiru AE `flarelytics_pageview_v1` rivimäärä vs `flarelytics` (legacy) Kiirulle | tarkista 2026-05-17 jälkeen |
| /track p99 ≤ baseline + 30 % (≤23.63 ms) | k6-ajo `perf/baseline-track.js` | OK 2026-05-10 (22.80 ms) |
| /track 5xx rate ≤ baseline + 0.1 % | CF dashboard worker analytics | tarkista |
| Per-query shadow drift (30 sample Kiiru) | EI VIELÄ — vaatii v1-querit (Phase 2) | ei sovellu Phase 0.5→1 |
| Distribution Loop view ≥3 editorial-päätöstä | qualitative — Kalle dokumentoi | **odottaa Loop-näkymän rakentamista** |

**Loop-näkymä** on Phase 0.5 deliverable joka EI vielä ole toteutettu. Phase 1:hin ei voi siirtyä ennen sitä JA 14 vrk käyttöä siitä.

---

## Kolme rinnakkaista työpolkua (valitse alku)

### Polku A — Distribution Loop -näkymä (Phase 0.5 deliverable, vaadittu cutoverille)

Approved-mockupit: `~/.gstack/projects/kalle-works-flarelytics/designs/` (variant-A Distribution Loop, variant-A Content Performance, variant-C Article Scorecard).

Ongelma: v1-data on AE:ssa mutta `QUERY_TEMPLATES` osoittaa v0:aan. Tarvitaan:
1. Uudet v1-queryt `packages/worker/src/queries/v1/` — pelkkä Loop-näkymä riittää aluksi
2. Loop-view `packages/dashboard/src/pages/loop.astro` — pageview_v1 + share_v1 + engagement_v1 join
3. **Important:** §3 D1-data ei vielä virtaa (queue consumer puuttuu) → `content_id`-aggregaatti ei toimi → Loop näyttää canonical_url_hash-tasolla. Käytännössä toimii Kiirulla koska 1 canonical = 1 article (ei vielä käännöksiä).

Riippuvuus: ei riipu queue consumerista, mutta D1-aggregaatti hyötyisi siitä.

### Polku B — Queue consumer + DIMENSIONS-kirjoitukset (alkuperäinen lista 3)

`packages/worker/src/enrich/` (uusi):
- Cloudflare Queue consumer-handler
- Lukee enrichment-jobit ENRICH_QUEUE:sta
- Mintaa content_id ja kirjoittaa D1.content + content_aliases (UPSERT)
- Resolvoi social_post_id-metadatan kun mahdollista
- Backpressure: queue depth > 5000 → degrade content_id minting -only

**TÄRKEÄÄ:** /track ei vielä push enrichment-jobeja queueen — se rajattiin pois Phase 0.5 scope:sta. Tarvitsee:
1. Lisää queue.send() handleTrack:n waitUntil-blokkiin Kiirulle
2. Toteuta consumer
3. Erillinen wrangler.toml [[queues.consumers]]-osio (jo olemassa example:ssa)
4. Oma deploy-keskustelu

Riippuvuus: tarvitsee D1-skeeman (✓ jo applied) ja queue-bindingin (✓).

### Polku C — Phase 1 portfolio dual-emit -laajennus

Kun §6 7 vrk Kiirulla on OK:
1. Muuta `V1_EMIT_SITES = new Set(['kiiru.fi'])` (index.ts:28) lukemaan KV-allowlistasta JA fallbackina koko `ALLOWED_ORIGINS`
2. Plan §4 Phase 1: "Tracker payload contract enforced for all sites (canonical_url required; fallback to inferred-canonical with flag)" → server-side fallback toimii jo (resolveCanonical), ei muutos tarvita
3. Phase 1 risk gate: re-mittaa /track p99 koko portfolion kuormalla (ei vain Kiiru) — odotettavissa sama tai parempi koska waitUntil on jo paikoilla
4. Queue depth alarm > 5000 — vaatii Polku B:n ensin

Riippuvuus: vaatii §6 cutover-kellon päättymisen + Loop-näkymän hyväksynnän.

---

## Kriittinen production-tila (älä riko)

**Worker:** `flarelytics` (https://flarelytics.kl100.workers.dev) — Cloudflare account `4afa9a2ef256ff7f1cec9ed91ff03561`
**Deploy-komento:** `cd packages/worker && npx wrangler deploy` (ei `--env staging`)
**Staging:** `flarelytics-staging` — käytä Phase 1 risk-gate-uudelleenmittauksiin
**Wrangler auth:** `npx wrangler login --browser` (OAuth-token vanhenee, ei pitkää tokenia)

**Bindings tuotannossa (ÄLÄ MUUTA NIMIÄ):**
- ANALYTICS (legacy) → `flarelytics`
- PAGEVIEW_EVENTS → `flarelytics_pageview_v1`
- ENGAGEMENT_EVENTS → `flarelytics_engagement_v1`
- SHARE_EVENTS → `flarelytics_share_v1`
- BOT_EVENTS → `flarelytics_bot_v1`
- PERFORMANCE_EVENTS → `flarelytics_performance_v1`
- CUSTOM_EVENTS → `flarelytics_custom_v1`
- DIMENSIONS (D1) → `flarelytics-dimensions` (id `7e55f9f3-700e-466c-95d5-cf267e3fed67`)
- ENRICH_QUEUE → `flarelytics-enrich` (id `864e5c89a3a647e9ae53b30279a7804d`)
- ARCHIVE (R2) → `flarelytics-archive`
- SITE_CONFIG (KV) → id `d332c72d6ea64643a1ed43ee732814b5`

---

## Mitä saa varmasti tehdä

- Lukea kaikki tiedostot reposta
- Tehdä uusi feature-branch (esim `feat/distribution-loop`, `feat/queue-consumer`, `feat/phase-1-portfolio`) **mainin päältä** — `design/migration-plan` on poistettu
- Kirjoittaa uusia moduuleja `packages/worker/src/queries/v1/`, `packages/worker/src/enrich/`, `packages/dashboard/src/`
- Lisätä testejä vitest-formaatissa (140 olemassa olevaa pass — älä riko)
- Committaa + pushata feature-branchiin

## Mitä EI saa ilman lupaa

- Mergetä mainiin (vaatii `/review` + erillisen luvan, kuten Phase 0.5:lla)
- Deployata Cloudflareen (`wrangler deploy`) — jokainen tuotanto-deploy vaatii Kallen luvan
- Käynnistää queue consumer -workeria tuotannossa (Polku B:n omat deploy-keskustelut)
- Muuttaa V1_EMIT_SITES-sisältöä ennen §6 cutover-kellon umpeutumista
- Poistaa legacy ANALYTICS-write — pysyy mukana Phase 4 saakka

---

## Tärkeimmät tiedostot

| Polku | Mitä on |
|---|---|
| `packages/worker/MIGRATION_PLAN.md` | SSOT — kaikki päätökset |
| `packages/worker/src/index.ts` | Tuotannon worker, dual-emit + waitUntil |
| `packages/worker/src/index.test.ts` | 42 testiä /track:lle (säilyy 100 % pass) |
| `packages/worker/src/v1/canonical.ts` | normalize + SHA-256[0:12] hash |
| `packages/worker/src/v1/emit.ts` | 5 typed emit-funktiota per family |
| `packages/worker/src/referrer/index.ts` | Social-platform parsing |
| `packages/worker/src/classifier/index.ts` | Bot/AI UA-luokittelu |
| `packages/worker/migrations/0001_initial.sql` | D1-skeema (applied to remote) |
| `packages/worker/wrangler.toml` | (gitignored) tuotannon konfiguraatio |
| `packages/worker/wrangler.toml.example` | Committoitu blueprint |
| `packages/worker/perf/baseline-track.js` | k6-skripti — `ORIGIN=https://kiiru.fi` Phase 1 -mittauksiin |

---

## Ensimmäinen viesti käyttäjälle

Sano näin:

> "Phase 0.5 on tuotannossa, §6 cutover-kello käynnissä. Olen lukenut MIGRATION_PLAN.md §4 (Phase 1) + §6 (cutover) + §11 (test reqs). Kolme polkua auki: A) Distribution Loop -näkymä (Phase 0.5 deliverable, vaadittu cutoverille), B) Queue consumer + D1-DIMENSIONS-kirjoitukset (alkuperäinen lista 3), C) Phase 1 portfolio dual-emit -laajennus (vaatii §6 cutoverin). Aloitan **[VALITSE A | B | C]**, teen feature-branchin mainin päältä, ja palaan sinulle review-tarkistuksiin ennen mergea. Vahvistatko suunnan?"

Odota vahvistus ennen kuin alat kirjoittaa lähdekoodia (yli 50 rivin scope).

---

## Muista (CLAUDE.md project + user)

- **Suomi** kommunikaatiossa, conventional commits committeihin
- **Älä mergea mainiin ilman lupaa** — `/review` ennen mergea, sitten erillinen "merge"-pyyntö
- **Älä mene palvelimille ilman lupaa** — wrangler deploy, ssh, kaikki remote-actionit luvanvaraisia
- **Tarkista context7:sta** kirjastojen toiminta ennen käyttämistä (esim. CF Queues, D1)
- **Featurebranch + testit + git push** jokaisesta featuresta
- **Älä koskaan poista AE legacy-kirjoituksia** ennen Phase 4
