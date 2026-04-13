# Flarelytics Query Reference

37 queries via `GET /query?q=<name>&period=<period>&site=<hostname>`
Auth: `X-API-Key: <QUERY_API_KEY>` header required.

**Periods:** `7d`, `14d`, `30d`, `60d`, `90d`, `180d`

## Public Stats (no API key)

`GET /public-stats?site=<hostname>` returns a 30-day summary: pageviews, visitors, top pages, referrers, countries, devices, daily views, bot hits total. Useful for public analytics pages.

## Traffic

| Query | Params | Description |
|---|---|---|
| `top-pages` | | Most viewed pages |
| `top-pages-visitors` | | Top pages with views + unique visitor counts |
| `top-pages-stories` | | Top pages where path starts with `/a/` |
| `daily-views` | | Pageviews per day |
| `daily-unique-visitors` | | Unique visitors per day |
| `new-vs-returning` | | New vs returning visitors |
| `total-sessions` | | Total sessions in period (based on timing events) |

## Referrers & Acquisition

| Query | Params | Description |
|---|---|---|
| `referrers` | | Top referrer hostnames |
| `referrers-by-page` | `?page=/path` | Referrer breakdown for a specific page |
| `utm-campaigns` | | UTM campaign totals (source, medium, campaign) |
| `utm-campaign-trend` | | Daily UTM visits — when each post drove traffic |
| `utm-by-page` | `?page=/path` | UTM campaign breakdown for a specific page |

## Content & Engagement

| Query | Params | Description |
|---|---|---|
| `page-views-over-time` | `?page=/path` | Daily views + visitors for one page |
| `page-timing` | | Average time on page in seconds |
| `timing-by-page` | `?page=/path` | Average time on page for a specific page |
| `bounce-rate-by-page` | `?event_name=N` | Bounce % per page (threshold seconds, default 10) |
| `scroll-depth` | | Scroll depth distribution across all pages |
| `scroll-depth-by-page` | | Scroll depth breakdown per page |
| `scroll-depth-for-page` | `?page=/path` | Scroll depth distribution for a specific page |

## Geography & Devices

| Query | Params | Description |
|---|---|---|
| `countries` | | Views by country |
| `countries-by-page` | `?page=/path` | Country breakdown for one page |
| `devices` | | Pageviews by device type (mobile/tablet/desktop) |
| `browsers` | | Browser breakdown |

## Conversions

| Query | Params | Description |
|---|---|---|
| `outbound-links` | | External link click destinations |
| `page-performance` | | Pages with views vs custom event CTR |
| `custom-events` | | Custom event counts by name + properties |
| `conversion-funnel` | | Daily pageviews → conversions |
| `funnel-by-event` | `?event_name=signup` | Daily funnel for a specific event |

## Live (30-minute window)

| Query | Description |
|---|---|
| `live-visitors` | Visitors and pageviews in the last 30 minutes |
| `live-pages` | Most visited pages in the last 30 minutes |
| `live-referrers` | Top referrers in the last 30 minutes |
| `hourly-today` | Pageviews by hour for the last 24 hours |

## Bot Reporting

| Query | Description |
|---|---|
| `bot-hits` | Top bot user-agents |
| `bot-hits-total` | Total bot hit count for the period |
| `bot-pages` | Pages most targeted by bots |
| `bot-daily` | Bot hits per day (trend) |
| `bot-countries` | Countries where bot traffic originates |

## Event Types

| Event | Automatic | Description |
|---|---|---|
| `pageview` | Yes | Page load with referrer, UTM, device, browser, country |
| `outbound` | Yes | External link clicks (destination in blob5) |
| `timing` | Yes | Time on page in seconds (fires on `visibilitychange`) |
| `scroll_depth` | Opt-in | Scroll milestones at 25/50/75/100% |
| `bot_hit` | Yes | Bot traffic recorded separately (UA in blob5) |
| `(custom)` | Manual | Any event via `flarelytics.track()` |

## Analytics Engine Schema

Each event stores:

| Field | Content |
|---|---|
| `blob1` | Page path |
| `blob2` | Referrer hostname (`direct` if none) |
| `blob3` | Country code |
| `blob4` | Event name (`pageview`, `timing`, `scroll_depth`, `bot_hit`, custom) |
| `blob5` | Event properties (pipe-separated) |
| `blob6–8` | UTM source, medium, campaign |
| `blob9` | Visitor hash (daily-rotating SHA-256 of IP+UA+date) |
| `blob10` | Site hostname — required in all WHERE clauses |
| `blob11` | Device type |
| `blob12` | Browser name |
| `double1` | Event count (always 1) |
| `double2` | Time on page seconds (timing events only) |
