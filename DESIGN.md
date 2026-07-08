# DESIGN.md — kdi UI

## Design direction

**Brutalist Soft — Yellow**

A modern brutalist style with softened edges: heavy black outlines, white surfaces, offset drop shadows, and a single yellow accent. The result is confident, functional, and distinct without being aggressive.

## Color strategy

Restrained palette with one strong accent:

- **Background:** `#fafafa`
- **Surface:** `#fdfdfd` (slightly tinted white, not pure `#fff`)
- **Surface secondary:** `#f5f5f5`
- **Border / outline:** `#1a1a1a`
- **Text:** `#1a1a1a`
- **Text dim:** `#666666`
- **Accent:** `#fff176` (soft yellow) — reserved for small badges, primary buttons, and the flag badge
- **Accent muted:** `#fff9c4` — used for larger active areas such as the selected navigation item
- **Accent text:** `#1a1a1a`
- **Warning:** `#ff6b6b`
- **Warning text:** `#1a1a1a` (dark text on warning backgrounds for WCAG AA contrast)
- **Success:** `#10b981`
- **Tenant badge:** `#dbeafe` background, `#1e40af` text
- **Created-by badge:** `#ede9fe` background, `#5b21b6` text
- **Reason badge:** `#ffedd5` background, `#9a3412` text

No gradients, no `#000`, no glass, no blur. Pure `#fff` is avoided on large surfaces; the surface token uses `#fdfdfd` to keep the palette consistent while remaining legible on `#fafafa` backgrounds.

## Typography

- **Font:** `Space Grotesk` for UI chrome (topbar, sidebar, nav, buttons, command bar, forms), `Inter` for body text inside `.work-area`
- **Hierarchy:** weight and size contrast, no decorative styles
- **Body:** 13–14px, line-height 1.45
- **Headings:** 24px board title, 36px page title, weight 600–700

## Elevation

- Cards: `2px 2px 0 #1a1a1a` offset shadow
- Columns: `3px 3px 0 #1a1a1a` offset shadow
- Hover: shift 1px right/down and reduce shadow to 1px
- No blur, no glow, no layered transparency

## Radius

- Large panels: 8px
- Cards / buttons / inputs: 6px
- Avatars / badges: 6px (not pill/rounded)
- Count badges: 6px

## Components

### Button
- Background: `#1a1a1a` (primary) / `#fdfdfd` (default)
- Text: `#fdfdfd` (primary) / `#1a1a1a` (default)
- Border: 1px solid `#1a1a1a`
- Radius: 6px
- Shadow: `2px 2px 0 #fff176` (accent shadow for all buttons)
- Hover: shift 1px and reduce shadow to `1px 1px 0 #1a1a1a`
- Focus-visible: `2px solid #fff176` outline for primary buttons

### Input / Select
- Background: transparent
- Border: 1px solid `#1a1a1a`
- Radius: 6px
- Shadow: `2px 2px 0 #1a1a1a`
- Padding: 6px 12px

### Card
- Background: `#fdfdfd`
- Border: 1px solid `#1a1a1a`
- Radius: 6px
- Shadow: `2px 2px 0 #1a1a1a`
- Hover: shift 1px, reduce shadow to 1px

### Column
- Background: `#fdfdfd`
- Border: 1px solid `#1a1a1a`
- Radius: 8px
- Shadow: `3px 3px 0 #1a1a1a`
- Padding: 16px

### Badge
- Background: `#fff176`
- Text: `#1a1a1a`
- Radius: 6px
- Warning / archived / stale: `#ff6b6b` background, `#1a1a1a` text
- Tenant: `#dbeafe` background, `#1e40af` text
- Created-by: `#ede9fe` background, `#5b21b6` text
- Reason / rate-limited: `#ffedd5` background, `#9a3412` text

### Avatar
- Background: `#1a1a1a`
- Text: `#ffffff`
- Radius: 6px
- Size: 24px

### Navigation item
- Default: transparent
- Hover: white background, inset outline 1px
- Active: muted yellow (`#fff9c4`) background, inset outline 2px

## Layout

- App shell: 220px sidebar, 60px topbar, full-height main area
- Work area padding: 28px
- Sidebar padding: 20px 16px
- Column gap: 18px
- Card gap: 12px

## Responsive behavior

- Sidebar becomes a horizontal strip at ≤768px
- Kanban columns reflow with `auto-fill` and collapse to a single column on mobile
- Board detail definition lists stack vertically on mobile
- Tables remain horizontal-scroll; no mobile table transform is required for this phase

## Accessibility

- Visible `:focus-visible` outline on all interactive elements (`2px solid var(--border)`)
- `prefers-reduced-motion` media query disables transitions and animations
- Archived rows use `opacity: 0.6`; ensure text contrast is verified if this value is lowered further

## CSS architecture

The app shell, base buttons, forms, tables, and utility classes live in `app.css`. Component-specific layout (kanban grid, column structure, card layout, filter bar layout, board detail layout) lives in the component’s own `<style>` block and consumes the global tokens.

Fonts are loaded via Google Fonts `@import` in `app.css` for now; self-hosting is the recommended next step to avoid render-blocking and simplify CSP.

## Motion

- Transitions: 0.15s–0.2s ease
- Only transform and box-shadow on hover
- No layout animations

## Absolute bans

- Side-stripe borders
- Gradient text
- Glassmorphism / blur
- Hero metric templates
- Identical card grids without variation
- Modals as default
- `#000` or pure `#fff` on large surfaces
