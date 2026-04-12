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
- **Scale:** 10px (labels) / 12px (mono UI) / 15px (secondary text, table data) / 16px (body) / 28px (h2) / 36px (mobile hero) / 52px (hero)

## Color
- **Approach:** Restrained — burnt orange is the only color, used sparingly
- **Accent:** #dc6b14 (burnt orange) — warm, energetic, distinct from every competitor
- **Accent hover:** #b45309
- **Accent text:** #b45309 — for body-text-sized links and labels (WCAG AA 5.5:1 on #fafaf9). Use #dc6b14 only for large text (≥18px) or decorative elements.
- **Accent light:** #fffbeb (badges, highlights)
- **Background:** #fafaf9 (warm off-white)
- **Surface:** #ffffff (cards, tables)
- **Border:** #e7e5e4
- **Border hover:** #f5f5f4
- **Text primary:** #1c1917 (warm near-black)
- **Text secondary:** #57534e
- **Text muted:** #78716c (WCAG AA 5.9:1 on #fafaf9)
- **Code block bg:** #1c1917 (dark, high contrast)
- **Code text:** #d6d3d1
- **Code accent:** #fbbf24 (bright amber for strings/highlights in code)
- **Data viz (secondary):** #57534e (stone-600) — for secondary/negative data like bot traffic. Keeps accent for real traffic, muted stone for blocked/filtered data.
- **Overlay backdrop:** rgba(0,0,0,0.5) — used for drill-down modal focus
- **Semantic:** success #16a34a, error #dc2626, warning #dc6b14 (same as accent)
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
- **Badges:** Amber light bg (#fffbeb), dark amber text (#92400e for WCAG AA 7.8:1), pill shape (border-radius: 20px), monospace font
- **KPI cards:** Monospace label (uppercase, muted), large monospace value
- **Progress/category bars:** Full-width track (border-light bg), filled bar (accent for positive data, stone-600 for secondary/filtered data), 2px radius. Label left, value right, monospace.
- **Scroll depth funnel:** Horizontal bars at 25/50/75/100% milestones. Accent fill, border-light track, monospace labels.
- **Overlay/drill-down modal:** Backdrop rgba(0,0,0,0.5), max-width 720px, surface-raised bg, border, radius-lg. Close on Escape, click-outside, or X button.
- **Data viz charts:** SVG bar charts. Accent fill for real traffic, stone-600 fill for bot/filtered data. Monospace axis labels, border-light grid lines (dashed).

## Anti-patterns (never use)
- Orange accent on dark background (wrong association)
- Purple/violet gradients
- Decorative blobs or illustrations
- Hero images or screenshots above the fold
- Rounded bubbly elements (keep radius tight at 4-6px)
- Generic SaaS marketing patterns (centered everything, 3-column icon grids)

## Accessibility
- **Target:** WCAG AA (4.5:1 for normal text, 3:1 for large text and UI components)
- **Primary text (#1c1917):** 43:1 on #fafaf9 — exceeds AAA
- **Secondary text (#57534e):** 8.0:1 on #fafaf9 — exceeds AAA
- **Muted text (#78716c):** 5.9:1 on #fafaf9 — passes AA
- **Accent as text (#b45309):** 5.5:1 on #fafaf9 — passes AA. Use for body-text links and labels.
- **Accent decorative (#dc6b14):** 3.8:1 on #fafaf9 — large text and icons only (passes 3:1 threshold)
- **Badge text (#92400e on #fffbeb):** 7.8:1 — passes AAA
- **Code text (#d6d3d1 on #1c1917):** 18.4:1 — exceeds AAA
- **Code accent (#fbbf24 on #1c1917):** 14.8:1 — exceeds AAA
- **Dark buttons (white on #1c1917):** 44:1 — exceeds AAA

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-30 | Variant C selected (Light + Amber) | Dark+orange = wrong association. Light with warm amber differentiates from dark-mode competitors while staying professional |
| 2026-03-30 | System fonts for body | Zero font loading beyond Satoshi display. Native feel. |
| 2026-03-30 | Monospace for all UI labels | Reinforces developer identity. Every label, nav link, button, and data element uses mono. |
| 2026-03-30 | Dark CTA buttons (not amber) | Amber is accent/highlight, not action. Dark buttons have better contrast and avoid "warning button" feel. |
| 2026-03-30 | WCAG AA contrast fixes | Muted text darkened (#a8a29e → #78716c), accent text tier added (#b45309 for body text), badge text darkened (#92400e). All text now meets 4.5:1 minimum. |
| 2026-03-30 | Burnt orange accent (#dc6b14) | Shifted from amber (#d97706) to burnt orange. More energy, still warm. WCAG 3.8:1 on light (better than amber's 3.0:1). |
| 2026-04-12 | Stone-600 (#57534e) for bot data viz | Bot/blocked traffic uses muted stone, real traffic uses accent orange. Visual separation without adding a new hue to the palette. |
| 2026-04-12 | Added overlay, progress bar, chart patterns | Dashboard expanded with bot analytics and article drill-down. Documented new component patterns to keep system coherent. |
