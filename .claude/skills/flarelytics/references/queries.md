# Flarelytics Query Reference

All queries: `GET /query?q=<name>&period=<period>&site=<hostname>`
Auth: `X-API-Key: <QUERY_API_KEY>` header required.

**Periods:** `7d`, `14d`, `30d`, `60d`, `90d`, `180d`

## Traffic

| Query | Description |
|---|---|
| `top-pages` | Most viewed pages |
| `top-pages-visitors` | Top pages with views + unique visitor counts |
| `top-pages-stories` | Top pages where path starts with `/a/` |
| `daily-views` | Pageviews per day |
| `daily-unique-visitors` | Unique visitors per day |
| `new-vs-returning` | New vs returning visitors |

## Referrers & Acquisition

| Query | Params | Description |
|---|---|---|
| `referrers` | | Top referrer hostnames |
| `utm-campaigns` | | UTM campaign totals (source, medium, campaign) |
| `utm-campaign-trend` | | Daily UTM visits — when each post drove traffic |

## Content & Engagement

| Query | Params | Description |
|---|---|---|
| `page-views-over-time` | `?page=/path` | Daily views + visitors for one page |
| `page-timing` | | Average time on page in seconds |
| `bounce-rate-by-page` | `?event_name=N` | Bounce % per page (threshold seconds, default 10) |
| `scroll-depth` | | Scroll depth distribution across all pages |
| `scroll-depth-by-page` | | Scroll depth breakdown per page |

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

## Analytics Engine Schema

Each event stores:

| Field | Content |
|---|---|
| `blob1` | Page path |
| `blob2` | Referrer hostname (`direct` if none) |
| `blob3` | Country code |
| `blob4` | Event name (`pageview`, `timing`, `scroll_depth`, custom) |
| `blob5` | Event properties (pipe-separated) |
| `blob6–8` | UTM source, medium, campaign |
| `blob9` | Visitor hash (daily-rotating SHA-256 of IP+UA+date) |
| `blob10` | Site hostname — required in all WHERE clauses |
| `blob11` | Device type |
| `blob12` | Browser name |
| `double1` | Event count (always 1) |
| `double2` | Time on page seconds (timing events only) |
