---
name: Takumi Industrial
colors:
  surface: '#0f141b'
  surface-dim: '#0f141b'
  surface-bright: '#343941'
  surface-container-lowest: '#090f15'
  surface-container-low: '#171c23'
  surface-container: '#1b2027'
  surface-container-high: '#252a32'
  surface-container-highest: '#30353d'
  on-surface: '#dee2ec'
  on-surface-variant: '#d8c3ad'
  inverse-surface: '#dee2ec'
  inverse-on-surface: '#2c3138'
  outline: '#a08e7a'
  outline-variant: '#534434'
  surface-tint: '#ffb95f'
  primary: '#ffc174'
  on-primary: '#472a00'
  primary-container: '#f59e0b'
  on-primary-container: '#613b00'
  inverse-primary: '#855300'
  secondary: '#4ae176'
  on-secondary: '#003915'
  secondary-container: '#00b954'
  on-secondary-container: '#004119'
  tertiary: '#ffbcb7'
  on-tertiary: '#68000a'
  tertiary-container: '#ff938c'
  on-tertiary-container: '#8d0012'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#ffddb8'
  primary-fixed-dim: '#ffb95f'
  on-primary-fixed: '#2a1700'
  on-primary-fixed-variant: '#653e00'
  secondary-fixed: '#6bff8f'
  secondary-fixed-dim: '#4ae176'
  on-secondary-fixed: '#002109'
  on-secondary-fixed-variant: '#005321'
  tertiary-fixed: '#ffdad7'
  tertiary-fixed-dim: '#ffb3ad'
  on-tertiary-fixed: '#410004'
  on-tertiary-fixed-variant: '#930013'
  background: '#0f141b'
  on-background: '#dee2ec'
  surface-variant: '#30353d'
typography:
  headline-xl:
    fontFamily: Noto Sans
    fontSize: 48px
    fontWeight: '800'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-xl-mobile:
    fontFamily: Noto Sans
    fontSize: 32px
    fontWeight: '800'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-lg:
    fontFamily: Noto Sans
    fontSize: 36px
    fontWeight: '700'
    lineHeight: 44px
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Noto Sans
    fontSize: 26px
    fontWeight: '700'
    lineHeight: 34px
    letterSpacing: 0em
  headline-md:
    fontFamily: Noto Sans
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
  headline-sm:
    fontFamily: Noto Sans
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Noto Sans
    fontSize: 20px
    fontWeight: '400'
    lineHeight: 30px
  body-md:
    fontFamily: Noto Sans
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  label-lg:
    fontFamily: Noto Sans
    fontSize: 18px
    fontWeight: '700'
    lineHeight: 24px
    letterSpacing: 0.04em
  label-md:
    fontFamily: Noto Sans
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 22px
    letterSpacing: 0.02em
  code-num:
    fontFamily: Noto Sans
    fontSize: 22px
    fontWeight: '700'
    lineHeight: 28px
    letterSpacing: 0.05em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1.5rem
  gutter-mobile: 1rem
  margin: 2rem
  margin-mobile: 1rem
  space-xs: 0.5rem
  space-sm: 0.75rem
  space-md: 1.25rem
  space-lg: 2rem
  space-xl: 3rem
---

## Brand & Style

This design system is engineered for harsh industrial shop floors, assembly lines, and heavy manufacturing workstations. The tone is utilitarian, authoritative, rugged, and profoundly calm. The interface prioritizes cognitive clarity under sensory-heavy environments (noise, overhead sodium/LED glare, physical fatigue), ensuring machine operators and assembly technicians execute complex standard operating procedures (SOPs) with absolute precision.

The design movement bridges **Industrial Utilitarianism** and **Tactile Modern**:
- **Utilitarian Discipline:** Screen density is low-to-medium, avoiding clutter. Visual hierarchy is strictly stratified so operators can absorb status indicators in sub-second glances from a 1-meter viewing distance.
- **Rugged Tactility:** Buttons, cards, and interactive steps feature mechanical boundaries, heavy visual anchors, and unambiguous state shifts designed for touch interfaces mounted on articulated workstation arms or ruggedized tablets.
- **Cognitive Ergonomics:** High visual contrast (exceeding WCAG AAA in critical workflows) counters factory floor glare. Semantic colors are tightly ring-fenced to prevent operational desensitization.

## Colors

The palette relies on a deep, non-reflective slate foundation paired with strict functional semantics. Ambient shop-floor lighting causes glare on consumer displays; this near-black slate absorbs light while preserving visual contrast.

### Palette Architecture
- **Canvas Base:** `#0F1318` (Deep industrial obsidian) provides maximum background contrast.
- **Surface Level 1 (Default Containers):** `#161B22` (Charcoal slate) separates general UI shells from the root viewport.
- **Surface Level 2 (Elevated Work Cards):** `#1E2530` (Tactile steel slate) houses active work instructions, interactive modules, and steps.
- **Surface Level 3 (Active Focus / Interactive Rest):** `#2A3442` (Lifted slate) defines input wells, inactive toggle fields, and tool trays.
- **Structural Outlines:** Subtle, crisp borders at `#2D3748` (unfocused/resting) and `#475569` (structural demarcation).
- **Primary Interactive (Safety Amber):** `#F59E0B` (Base), `#FBBF24` (Hover/Active Highlight), `#D97706` (Pressed/Border Accent). Reserved exclusively for primary actions, current active training step indicators, and high-visibility interaction paths.
- **Typography:** `#F3F5F7` (Primary, unyielding high contrast) and `#C5CED8` (Secondary, supporting instructions and metadata). Muted text never falls below `#8B949E` to guarantee readability under low-angle inspection lights.

### Strict Semantic Guardrails
- **Step Complete / Verified State (`#22C55E`):** Exclusively reserved for task sign-offs, validated machine steps, and completed work cycles. Never used for general branding or non-positive notifications.
- **Safety Critical / Halt State (`#EF4444`):** Strictly restricted to E-stop warnings, lock-out/tag-out (LOTO) requirements, out-of-tolerance sensor alarms, and critical procedural failures. Never used for destructive secondary button clicks or trivial dismissals.

## Typography

The type system is powered by **Noto Sans** to provide native visual continuity across multinational manufacturing workforces (with zero-glyph fallbacks across Noto Sans JP, Noto Sans Devanagari, and Vietnamese character sets).

### Readability Mandate
- **Baseline Text Scale:** Standard running body text starts strictly at `18px` (`body-md`). Micro-text is eliminated; industrial personnel frequently view monitors at standing desk distances.
- **Numbers and Step Identifiers:** Tactical data points, torque specs, gauge tolerances, and step indices utilize tabular alignment (`code-num` / `tnum`) with bold weights to avoid misinterpretation of decimal places.
- **Punchy Case Architecture:** Critical operational headers and interactive action labels leverage heavy font weights (`700`–`800`) with generous line-heights to eliminate line overlap across multi-line translations.

## Layout & Spacing

The layout is structured around an industrial **Fluid Grid with Locked Operational Zones**:
- **Desktop & Workstation Terminals (1024px+):** A 12-column layout with `2rem` outer margins and `1.5rem` gutters. Content splits cleanly between the coaching timeline (4 columns) and the real-time execution canvas (8 columns).
- **Rugged Tablets & HMI Panels (768px - 1023px):** An 8-column layout with `1.5rem` outer margins. SOP instructions anchor to the upper half, with verification actions permanently docked within thumb-reach along the lower quadrant.
- **Handheld Devices (Mobile under 768px):** A 4-column layout utilizing edge-to-edge structural cards, `1rem` gutters, and pinned bottom toolbars for critical inputs.

### Spatial Rhythm
Component padding uses an expanded rhythm (`space-md` of `1.25rem` and `space-lg` of `2rem`) to isolate touch targets. Cramped UI patterns are prohibited to eliminate mis-taps caused by gloved hands, physical vibrations, or oily protective glass screens.

## Elevation & Depth

Ambient shadows and atmospheric blurs are deliberately omitted; in harsh industrial lighting, fuzzy drop shadows reduce contrast and read as screen smudges. Depth is conveyed exclusively through **Tonal Stacking and High-Visibility Structural Borders**:

1. **Floor (Root Viewport):** `#0F1318` solid backdrop.
2. **Level 1 (Panels & Trays):** `#161B22` with a `1px` solid border in `#2D3748`.
3. **Level 2 (Active Step Cards & Work Benches):** `#1E2530` with a `1.5px` solid border in `#3B4656`.
4. **Focused / Critical Target:** `#1E2530` overlaid with a `2px` solid highlight border in Safety Amber (`#F59E0B`).

Modals, lock-out dialogs, and emergency procedures utilize a solid `85%` blackout overlay (`#070A0D`) to completely disengage background tasks, forcing focused operational resolution.

## Shapes

The interface balances rugged industrial machinery lines with modern usability by standardizing on `rounded-lg` (16px) and `rounded-xl` (20px) outer corners for major card containers:
- **Major Workstation Modules & Step Containers:** Bound by `16px` to `20px` corners, mitigating the visual hostility of brutalist sharp rectangles while preserving structural alignment.
- **Buttons and Primary Interactive Touchpoints:** Standardized on `8px` to `12px` roundedness. Pill-shaped buttons are prohibited; sharp-pill boundaries degrade touch predictability on resistive touch screens.
- **Pills / Status Badges:** Fixed at `6px` subtle rounding to maintain an instrument-panel aesthetic.

## Components

### Touch Targets & Hit Areas
All interactive components (buttons, dropdowns, checkboxes, step toggles) maintain a **strict minimum height of 56px**, expanding to **64px** for critical primary completion actions. Internal padding must never place label text within 16px of a border edge.

### Buttons
- **Primary Action (Safety Amber):** Minimum height `56px` (ideal `64px`). Background `#F59E0B`, text `#0F1318` (high-contrast black, weight `700`). Resting state features a `1px` solid `#D97706` bottom bevel line. Active state darkens to `#D97706`.
- **Step Complete Button:** Background `#22C55E`, text `#052E16` (weight `700`), height `64px`. Displays a checkmark icon aligned right. Used once per sub-task.
- **Emergency Halt / Lock-Out:** Background `#EF4444`, text `#FFFFFF` (weight `800`), bordered with a `2px` solid `#B91C1C`. Always accompanied by a triangular warning glyph.
- **Secondary / Auxiliary:** Background `#2A3442`, text `#F3F5F7`, border `1.5px` solid `#475569`.

### Workstation Cards & Step Containers
- Cards use `#1E2530` backgrounds with `20px` padding on mobile and `32px` on desktop.
- The active SOP step receives a persistent left-edge accent border: `4px` solid `#F59E0B`.
- Completed steps transition to `#161B22` background with muted text (`#8B949E`) and a `1.5px` solid border in `#22C55E`.

### Form Controls & Numerical Inputs
- **Checkboxes & Radios:** Hit area `56px × 56px`. The visual control element measures `28px × 28px` with a `2px` border in `#C5CED8`. When checked, the box fills with `#22C55E` featuring an oversized white glyph.
- **Steppers & Numerical Inputs:** Incremental buttons (`+` / `-`) must be minimum `56px × 56px` separated by an illuminated read-out displaying values in `24px` bold tabular numerals.
- **Text & Barcode Fields:** Input boxes measure `56px` tall, filled with `#161B22`, framed by a `1.5px` border in `#475569`. Focused fields flash a `2px` solid `#F59E0B` outline.

### Status Chips & Badges
- Compact indicators (e.g., "STATION 04", "TORQUE VERIFIED") utilize `#161B22` background with a `1px` solid frame colored according to semantic status.
- Text is always uppercase, tracking `0.04em`, font size `16px`, weight `700`.

### Iconography
- High-visibility mono-line industrial icons set with a uniform `2.5px` stroke weight.
- Never rely on color alone: icons must always accompany textual status flags (e.g., warning triangle with Halt, check circle with Verified, wrench with Calibration).