# Design System — Flarelytics

## Product Context
- **What this is:** Privacy-first web analytics that runs entirely on Cloudflare
- **Who it's for:** Developers and indie makers who use Cloudflare
- **Space/industry:** Developer tools, analytics (competitors: Plausible, Fathom, Counterscale)
- **Project type:** Open source developer tool with landing page + dashboard

## Aesthetic Direction
- **Direction:** Industrial/Developer-First with warm accessibility
- **Decoration level:** Minimal — typography and whitespace do all the work
- **Mood:** Professional developer tool that feels approachable and trustworthy. Light, clean, warm. The dark code blocks provide contrast and signal "this is for builders." Amber accent adds warmth without being generic.
- **Reference sites:** Vercel, Linear, Resend (clean developer tool aesthetic, light mode)

## Typography
- **Display/Hero:** Satoshi 900 — geometric, modern, not overused in the analytics space. Letter-spacing: -0.035em
- **Body:** System UI stack (-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif) — zero load time, native feel
- **UI/Labels:** SF Mono / Fira Code (monospace) — reinforces developer identity, used for nav links, section labels, data labels, buttons
- **Data/Tables:** SF Mono / Fira Code with tabular-nums — clean number alignment
- **Code:** SF Mono / Fira Code
- **Loading:** Satoshi via Fontshare CDN (`https://api.fontshare.com/v2/css?f[]=satoshi@700,900&display=swap`). All other fonts are system fonts (zero load).
- **Scale:** 10px (labels) / 12px (mono UI) / 12.5px (table data) / 14.5px (body) / 16px (lead) / 36px (specimen) / 52px (hero)

## Color
- **Approach:** Restrained — amber is the only color, used sparingly
- **Accent:** #d97706 (amber) — warm, trustworthy, distinct from every competitor
- **Accent hover:** #b45309
- **Accent light:** #fffbeb (badges, highlights)
- **Background:** #fafaf9 (warm off-white)
- **Surface:** #ffffff (cards, tables)
- **Border:** #e7e5e4
- **Border hover:** #f5f5f4
- **Text primary:** #1c1917 (warm near-black)
- **Text secondary:** #57534e
- **Text muted:** #a8a29e
- **Code block bg:** #1c1917 (dark, high contrast)
- **Code text:** #d6d3d1
- **Code accent:** #fbbf24 (bright amber for strings/highlights in code)
- **Semantic:** success #16a34a, error #dc2626, warning #d97706 (same as accent)
- **Dark mode:** Not planned for v1. Dashboard will be dark by default (separate palette).

## Spacing
- **Base unit:** 4px
- **Density:** Compact — developer tools should be information-dense
- **Scale:** 4 / 6 / 8 / 10 / 12 / 14 / 16 / 20 / 24 / 32 / 40 / 48 / 56 / 72px
- **Section gaps:** 48-56px between major sections
- **Card padding:** 16-20px
- **Table cell padding:** 7-8px vertical, 12px horizontal

## Layout
- **Approach:** Grid-disciplined
- **Max content width:** 880px
- **Grid:** Single column for landing, 2-4 columns for dashboard and feature grids
- **Border radius:** 6px (cards, buttons, code blocks). 4px for small elements. 20px for badges/pills.

## Motion
- **Approach:** Minimal-functional
- **Transitions:** 120ms for buttons and interactive states
- **Hover effects:** Border color change or subtle box-shadow (0 2px 8px rgba(0,0,0,0.06))
- **No:** entrance animations, scroll-driven effects, loading spinners beyond skeleton states

## Logo
- **Mark:** 32x32px rounded rectangle (rx=6), fill #1c1917 (dark). Three vertical bars inside representing analytics data, fill #fbbf24 (bright amber), heights 12/16/8px ascending pattern.
- **Wordmark:** "flarelytics" in monospace font, 15px, weight 500
- **Usage:** Mark + wordmark in nav. Mark only for favicon and small contexts.

## Component Patterns
- **Buttons primary:** Dark background (#1c1917), white text. NOT amber — amber is accent, not action.
- **Buttons secondary:** Transparent, 1px border, muted text. Hover: dark border, dark text.
- **Cards:** White surface, 1px border, 6px radius, 16-20px padding
- **Tables:** Monospace font for headers (uppercase, 10px, muted), tabular-nums for data
- **Code blocks:** Dark bg (#1c1917), amber highlights for strings/success, gray for comments
- **Badges:** Amber light bg, amber text, pill shape, monospace font
- **KPI cards:** Monospace label (uppercase, muted), large monospace value

## Anti-patterns (never use)
- Orange accent on dark background (wrong association)
- Purple/violet gradients
- Decorative blobs or illustrations
- Hero images or screenshots above the fold
- Rounded bubbly elements (keep radius tight at 4-6px)
- Generic SaaS marketing patterns (centered everything, 3-column icon grids)

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-30 | Variant C selected (Light + Amber) | Dark+orange = wrong association. Light with warm amber differentiates from dark-mode competitors while staying professional |
| 2026-03-30 | System fonts for body | Zero font loading beyond Satoshi display. Native feel. |
| 2026-03-30 | Monospace for all UI labels | Reinforces developer identity. Every label, nav link, button, and data element uses mono. |
| 2026-03-30 | Dark CTA buttons (not amber) | Amber is accent/highlight, not action. Dark buttons have better contrast and avoid "warning button" feel. |
