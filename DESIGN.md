# DESIGN.md — kdi UI

## Design direction

**Brutalist Soft — Yellow**

A modern brutalist style with softened edges: heavy black outlines, white surfaces, offset drop shadows, and a single yellow accent. The result is confident, functional, and distinct without being aggressive.

## Color strategy

Restrained palette with one strong accent:

- **Background:** `#fafafa`
- **Surface:** `#ffffff`
- **Surface secondary:** `#f5f5f5`
- **Border / outline:** `#1a1a1a`
- **Text:** `#1a1a1a`
- **Text dim:** `#666666`
- **Accent:** `#fff176` (soft yellow)
- **Accent text:** `#1a1a1a`
- **Warning:** `#ff6b6b`

No gradients, no `#000`, no `#fff`, no glass, no blur.

## Typography

- **Font:** `Space Grotesk` for UI, `Inter` for body text
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
- Background: `#1a1a1a`
- Text: `#ffffff`
- Border: 1px solid `#1a1a1a`
- Radius: 6px
- Shadow: `2px 2px 0 #fff176`
- Hover: shift 1px and reduce shadow

### Input / Select
- Background: transparent
- Border: 1px solid `#1a1a1a`
- Radius: 6px
- Shadow: `2px 2px 0 #1a1a1a`
- Padding: 6px 12px

### Card
- Background: `#ffffff`
- Border: 1px solid `#1a1a1a`
- Radius: 6px
- Shadow: `2px 2px 0 #1a1a1a`
- Hover: shift 1px, reduce shadow to 1px

### Column
- Background: `#ffffff`
- Border: 1px solid `#1a1a1a`
- Radius: 8px
- Shadow: `3px 3px 0 #1a1a1a`
- Padding: 16px

### Badge
- Background: `#fff176`
- Text: `#1a1a1a`
- Radius: 6px
- Warning: `#ff6b6b` background, white text

### Avatar
- Background: `#1a1a1a`
- Text: `#ffffff`
- Radius: 6px
- Size: 24px

### Navigation item
- Default: transparent
- Hover: white background, inset outline 1px
- Active: yellow background, inset outline 2px

## Layout

- App shell: 220px sidebar, 60px topbar, full-height main area
- Work area padding: 28px
- Sidebar padding: 20px 16px
- Column gap: 18px
- Card gap: 12px

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
- `#000` or `#fff`
