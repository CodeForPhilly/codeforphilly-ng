---
status: in-progress
depends: []
specs:
  - specs/screens/home.md
issues: []
---

# Plan: Hero photo slideshow

## Scope

Replace the homepage hero's looped `<video>` background with a Ken Burns–style photo slideshow that crossfades between a curated set of event photos, each performing a slow ambient pan in a randomized direction. Includes the optimization pipeline for the source photos, the new component, a small reduced-motion hook, the spec update, and the necessary test mock patch.

## Implements

- [screens/home.md](../specs/screens/home.md) — Section 1 (Hero), Background bullet

## Approach

### 1. Spec update first

Per the spec-first convention in [`.claude/CLAUDE.md`](../.claude/CLAUDE.md), update [screens/home.md](../specs/screens/home.md) Section 1's "Background" bullet to describe the slideshow (assets in `public/hero/`, 8s/1.5s timing, ±2% pan on 1.05→1.10 scale, `prefers-reduced-motion` honored).

### 2. Photo pipeline — `apps/web/scripts/optimize-hero-photos.sh`

Bash + ImageMagick. Takes the input directory as its sole positional arg so it's reproducible by anyone with the originals. For each image in stable sort order:

- Resize to cover 1920×1280, center-crop
- Strip EXIF
- Write `apps/web/public/hero/NNN.jpg` (q82) and `apps/web/public/hero/NNN.webp` (q80)

After the loop, write `apps/web/public/hero/manifest.json` — an array of `{ jpg, webp }` URLs in numeric order.

Originals stay outside the repo. Optimized files + manifest are the committed artifact.

### 3. `usePrefersReducedMotion` hook

`apps/web/src/hooks/usePrefersReducedMotion.ts` — same shape as [`useOnline.ts`](../apps/web/src/hooks/useOnline.ts); `matchMedia` guarded for JSDOM.

### 4. `HeroSlideshow` component

`apps/web/src/components/HeroSlideshow.tsx`:

- Fetch `/hero/manifest.json` once on mount, Fisher-Yates shuffle.
- Two absolutely-positioned `<picture>` layers; the current is always rendered, the next renders only during a transition.
- Pan via a single `@keyframes ken-burns` defined in the module; per-layer random vector passed in as CSS custom properties (`--kb-from-x`, `--kb-to-x`, `--kb-from-y`, `--kb-to-y`); animation `9.5s linear forwards` (covers visible + crossfade).
- Random vector: each axis component in ±2%; scale 1.05→1.10 so the image always over-covers the box.
- 8s visible → preload next image (`new Image()` + `onload`, ~3s cap) → 1.5s crossfade → swap → repeat.
- `prefers-reduced-motion` → `animation: none` on layers; crossfade still runs.
- All timers in `useRef`; cleared on unmount.

### 5. Home.tsx wiring

Remove the `<video>` block. Mount `<HeroSlideshow className="absolute inset-0" />` with a sibling gradient overlay (`bg-gradient-to-br from-black/50 via-black/30 to-black/50`) for text contrast. Drop the section's `from-primary/5` gradient since photos supply the background. Adjust headline/subhead text colors to remain legible over photos.

### 6. Test patch

Add a `/hero/manifest.json` → `[]` branch to the `fetch` spy in `apps/web/tests/Home.test.tsx` so the component renders nothing in JSDOM and existing assertions remain valid.

## Validation

- [ ] `bash apps/web/scripts/optimize-hero-photos.sh <dir>` produces 16 JPGs (~150–250 KB each), 16 WebPs, and a `manifest.json` of length 16
- [ ] `npm run -w apps/web dev` — hero photos cycle every ~8 s with a visible slow pan
- [ ] Two consecutive transitions are smooth crossfades (no hard cut)
- [ ] Hard-reload several times — photo order differs across loads
- [ ] DevTools → Rendering → "prefers-reduced-motion: reduce" → pans stop, crossfades continue
- [ ] DevTools → Network throttle Fast 3G → no blank frame during transitions
- [ ] Hero text legible over every photo (gradient overlay does its job)
- [ ] `npm run -w apps/web test` — Home.test.tsx passes
- [ ] `npm run -w apps/web build` — no TS errors; `dist/hero/` contains 16 jpg + 16 webp + manifest.json
- [ ] `npm run type-check` and `npm run lint` clean
- [ ] `specs/screens/home.md` no longer mentions "looped, muted video"

## Risks / unknowns

- JSDOM does not define `window.matchMedia` by default; the hook must guard against `undefined` to avoid throwing in tests.
- WebP encoder availability depends on the local ImageMagick build — script should fail loudly with a clear message if `magick` can't emit WebP rather than silently producing JPG-only.
- Image weight in the bundle: 16 JPGs at ~200 KB plus 16 WebPs at ~140 KB ≈ 5.4 MB committed to the repo; acceptable for a one-off hero set but the script should keep file sizes in check.

## Notes

_(filled at done time)_

## Follow-ups

_(filled at done time)_
