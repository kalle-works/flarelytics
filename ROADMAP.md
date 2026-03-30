# Flarelytics — 12-Month Roadmap (Q2 2026 → Q1 2027)

## Context

Flarelytics is a working MVP: tracking worker, <1KB tracker, dashboard, email reports, and a landing page. All running on Cloudflare. The privacy analytics market is growing 25%+ annually ($3-4B → $12-28B by 2030). Counterscale is the only direct CF competitor (2K stars, no email reports, no custom events). Plausible proved the playbook: build in public, HN launch, content-first growth.

Current state: 0 users, 0 stars, 0 npm downloads, 0 revenue. Everything works but nobody knows it exists.

## The Strategy

**Free self-hosted core** that spreads through developer word-of-mouth. **Hosted tier** for people who don't want to manage infra. Revenue from hosted, not from limiting the open-source version.

Marginal cost per hosted customer is near-zero on Cloudflare. Price 50-70% below competitors ($5-15/mo vs Plausible's $19+/mo).

---

## Q2 2026 — Stability & Launch (Apr-Jun)

**Goal:** Ship v1.0 and get the first 100 users.

### Product
- [ ] **CLI setup tool** — `npx create-flarelytics` interactive wizard. Prompts for CF account, dataset, origins. Generates wrangler.toml, validates API token, deploys worker in one command. Target: 0 → tracking in under 3 minutes.
- [ ] **Fix email-reports config** — Remove hardcoded MailToolFinder values (SITE_NAME, SITE_URL, EMAIL_FROM). Make fully configurable via wrangler.toml vars.
- [ ] **Dashboard improvements** — Custom date range picker (beyond 7d/30d/90d). Page detail view (click a page → see its referrers, UTM, events). Country flags next to country codes.
- [ ] **Public demo dashboard** — Snapshot data at flarelytics.dev/demo. Developers want to see the product before deploying.
- [ ] **Dogfood** — Deploy Flarelytics tracking on flarelytics.dev itself.

### Technical
- [ ] **Test suite** — Vitest for worker (query templates, bot filtering, CORS, hash rotation), tracker (pageview detection, outbound links, sendBeacon), email-reports (HTML generation, anomaly detection). Target: 80%+ coverage.
- [ ] **CI/CD** — GitHub Actions: test on push, build all packages, deploy worker on release tag, publish npm packages on version tag.
- [ ] **npm packages** — Publish `@flarelytics/tracker` (ESM+CJS+types). The worker and dashboard stay as source (clone-and-deploy model).
- [ ] **Rate limiting** — Per-origin throttle on /track endpoint. Prevent abuse without external deps.
- [ ] **API versioning** — Prefix query endpoints with /v1/. Don't break existing integrations later.

### Growth
- [ ] **README rewrite** — 5-minute quickstart with GIF/video showing the full flow.
- [ ] **API reference docs** — All 10 query types, params, response shapes, example responses.
- [ ] **Migration guides** — "Replace Google Analytics in 5 minutes", "Switch from Plausible".
- [ ] **awesome-selfhosted** — Submit PR to awesome-selfhosted/awesome-selfhosted list.
- [ ] **awesome-cloudflare** — Submit PR to cloudflare/awesome list.

### Milestones
| Metric | Target |
|--------|--------|
| GitHub stars | 100 |
| npm downloads/mo | 500 |
| Active deployments | 100 |
| Test coverage | 80% |

---

## Q3 2026 — Growth & Monetization (Jul-Sep)

**Goal:** 1,000 deployments. First revenue.

### Product
- [ ] **Flarelytics Cloud** — Hosted version. One-click setup, no Cloudflare account needed. Pricing: Free (1 site, 10K events/mo) / Starter $5/mo (3 sites, 100K events) / Pro $15/mo (unlimited sites, 1M events, email reports, custom domain).
- [ ] **Goals & Conversions** — Define goals in dashboard ("signup form submitted", "pricing page viewed"). Track conversion rates. This is the #1 feature users ask for in privacy analytics.
- [ ] **Real-time counter** — Live visitor count on dashboard. Poll Analytics Engine every 5s. Show "X visitors right now" badge.
- [ ] **KPI sparklines** — 7-day trend mini-charts on each KPI card. Visual momentum at a glance.
- [ ] **Advanced filters** — Filter dashboard by country, referrer, UTM source. Drill into any dimension.
- [ ] **Email report frequency** — Weekly, biweekly, or monthly options. Per-recipient preferences.

### Technical
- [ ] **Stripe integration** — For Flarelytics Cloud billing. Usage-based metering via CF Workers.
- [ ] **Multi-tenant worker** — Single worker serves multiple sites. Route by domain. KV stores per-site config.
- [ ] **D1 for config** — Migrate site/team/goals config from KV to D1 (5GB free, SQL queries, better than KV for structured data).
- [ ] **Unsubscribe links** — HMAC-signed unsubscribe URLs in email reports (PLAN.md item, still missing).
- [ ] **E2E tests** — Playwright tests for dashboard auth, data loading, CSV export, period switching.

### Growth
- [ ] **Product Hunt launch** — Target Tuesday, aim for top 5. Prep: demo video, comparison screenshots, founder story.
- [ ] **Show HN** — Post: "Flarelytics: Privacy analytics that runs on CF free tier for $0". Include live demo link.
- [ ] **Content marketing** — Blog posts: "Why I Built Another Analytics Tool", "Cloudflare Analytics Engine Deep Dive", "Privacy Analytics Comparison 2026".
- [ ] **Template repos** — `next-flarelytics-starter`, `astro-flarelytics-starter`, `sveltekit-flarelytics-starter`. Pre-configured projects with Flarelytics tracking.
- [ ] **Dev.to + Indie Hackers** — Build-in-public posts. Monthly revenue updates.

### Milestones
| Metric | Target |
|--------|--------|
| GitHub stars | 500 |
| npm downloads/mo | 5,000 |
| Active deployments | 1,000 |
| Landing page visits/mo | 5,000 |
| MRR | $500 |

---

## Q4 2026 — Features & Moat (Oct-Dec)

**Goal:** 5,000 deployments. Feature parity with Plausible on core analytics.

### Product
- [ ] **Zaraz Managed Component** — Package Flarelytics as a Cloudflare Zaraz component. Any CF user adds analytics from their Cloudflare dashboard without touching code. This is the distribution channel nobody else has.
- [ ] **Funnel builder** — Visual multi-step funnel (not just the current 2-step pageview→event). Define: Landing → Signup → Onboarding → Purchase. See drop-off at each step.
- [ ] **Data export** — CSV/JSON export for all data, all periods. Schedule automatic exports to R2 or email.
- [ ] **Slack integration** — Weekly report to Slack channel. Anomaly alerts as DMs. `/flarelytics` slash command for quick stats.
- [ ] **Multi-site dashboard** — One login, toggle between sites. Team members with view/edit/admin roles.
- [ ] **Public dashboards** — Shareable read-only link. Embed iframe on public pages. Good for transparency.

### Technical
- [ ] **R2 archival** — Solve the 90-day Analytics Engine retention limit. Nightly cron exports daily aggregates to R2. Dashboard queries hot data (AE, 90d) + cold data (R2, unlimited). This is the single biggest feature gap vs traditional analytics.
- [ ] **Worker performance** — Pre-compiled SQL templates. Response caching with stale-while-revalidate. Target: <50ms p99 for all queries.
- [ ] **Webhook system** — Fire webhooks on anomalies, goal completions, threshold breaches. POST to any URL.
- [ ] **GA4 importer** — Import Google Analytics 4 data into Flarelytics. Lower the switching cost.

### Growth
- [ ] **Partner program** — 30% recurring commission for referrals. Affiliate dashboard.
- [ ] **Case studies** — 3-5 customer stories with before/after metrics.
- [ ] **Conference talks** — Submit to Cloudflare Dev Week, React Conf, JSConf.
- [ ] **Video content** — YouTube tutorial series: setup, custom events, funnels, email reports.

### Milestones
| Metric | Target |
|--------|--------|
| GitHub stars | 1,500 |
| npm downloads/mo | 20,000 |
| Active deployments | 5,000 |
| Landing page visits/mo | 20,000 |
| MRR | $5,000 |

---

## Q1 2027 — Platform & Scale (Jan-Mar)

**Goal:** 10,000 deployments. Ecosystem effects. Sustainable revenue.

### Product
- [ ] **White-label dashboard** — Custom domain (analytics.yourcompany.com), custom branding (logo, colors). Branded email reports. For agencies selling analytics to clients. $20/mo add-on.
- [ ] **AI insights** — Workers AI for natural language queries ("what drove traffic last week?"), anomaly explanation, growth suggestions. Use Cloudflare's built-in AI, zero external deps.
- [ ] **Annotations** — Mark events on the timeline (campaign launched, feature shipped, bug fixed). Correlate traffic changes with actions.
- [ ] **API v2** — GraphQL endpoint alongside REST. Let developers build custom dashboards and integrations.
- [ ] **Mobile dashboard** — PWA-optimized dashboard. Push notifications for anomaly alerts.

### Technical
- [ ] **Edge caching** — Cache dashboard API responses at the edge. Sub-20ms globally.
- [ ] **Durable Objects** — Real-time unique visitor counter using DO for accurate de-duplication within the same minute window.
- [ ] **Plugin architecture** — Let third parties build tracker plugins (scroll depth, form analytics, video play tracking) that integrate via `flarelytics.use(plugin)`.
- [ ] **SOC 2 prep** — If enterprise customers appear, begin compliance documentation.

### Growth
- [ ] **Enterprise outreach** — Target SMBs who need GDPR compliance. Direct sales for 10+ sites.
- [ ] **Community** — Discord server. Monthly community calls. Contributor recognition program.
- [ ] **Localization** — Dashboard and docs in German, French, Spanish, Japanese. Privacy laws vary by country, explain compliance per region.
- [ ] **Integration marketplace** — Zapier, Make, n8n triggers. WordPress plugin. Shopify app.

### Milestones
| Metric | Target |
|--------|--------|
| GitHub stars | 3,000 |
| npm downloads/mo | 50,000 |
| Active deployments | 10,000 |
| MRR | $20,000 |
| Team size | 2-3 |

---

## Key Decision Points

| When | Decision | Options |
|------|----------|---------|
| Q2 Week 8 | Monetize or stay free? | A) Launch Flarelytics Cloud  B) Stay OSS-only, monetize later  C) Sponsorware model |
| Q3 Week 4 | HN/PH launch timing | A) Launch both same week  B) Space 4 weeks apart  C) PH first, HN after traction |
| Q3 Week 12 | Database choice | A) Stay KV-only  B) Add D1 for structured config  C) External Postgres (Neon/Supabase) |
| Q4 Week 4 | Zaraz integration | A) Build MC  B) Partner with CF directly  C) Skip, focus on npm distribution |
| Q1'27 Week 4 | Raise or bootstrap? | A) Bootstrap to profitability  B) Raise pre-seed for team/marketing  C) Find a co-founder |

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| 90-day AE retention | Users need yearly data | R2 archival (Q4). Position 90d as "hot data" with unlimited cold storage. |
| CF prices AE | Cost model breaks | Monitor pricing. At scale, negotiate enterprise deal. Current: not billed. |
| Counterscale ships email/events | Lose differentiation | Move fast. CLI + hosted tier + Zaraz MC create switching cost. |
| Single maintainer | Bus factor = 1 | Open source community. Document everything. Revenue enables hiring. |
| No viral loop | Linear growth only | Referral program (Q4). Public dashboards (Q4). Template repos (Q3). |

---

## Immediate Next Steps (This Week)

1. Create feature branch for CLI setup tool
2. Write first 10 worker tests
3. Set up GitHub Actions (test on push)
4. Submit to awesome-selfhosted
5. Deploy Flarelytics tracking on flarelytics.dev

---

## Out of Scope (Not This Year)

- Session replay or heatmaps (different product category)
- A/B testing framework (too complex, dilutes focus)
- Mobile SDK (web-first for year 1)
- Multi-region data residency (CF Workers are global by default)
- HIPAA compliance (healthcare is a different market)
