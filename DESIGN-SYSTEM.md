# Design system migration — execution spec

Companion to the `TODO.md` § "Design system pass" audit. **That document explains *why*. This one
says *what to type*.** If the two disagree, this one wins.

Written to be executed without further design judgment. Every value below is resolved — there are
no "decide", "consider" or "roughly" items left. If you hit a case this spec doesn't cover, **stop
and ask** rather than inventing a value; inventing values is the exact failure this migration
exists to undo.

**Audience:** an agent or developer executing one tranche at a time.

---

## 0. Non-negotiables

Read this section before touching anything.

### Do not touch

| Thing | Where | Why |
|---|---|---|
| Nav breakpoints `900px` / `1200px` / `1310px` | `src/layouts/Layout.astro` | v2.27.1 and v2.27.2 were both bug fixes to exactly these. They are load-bearing and tuned by hand. |
| WoW quality / class colors | everywhere (`#1eff00`, `#0070dd`, `#a335ee`, `#ff8000`, `#e6cc80`) | Blizzard's palette. Tokenize the *name*, never change the *value*. |
| `esc()` and its call sites | `src/components/RaiderSimTools.astro` | XSS escaping the security audit explicitly signed off on. |
| Any class name read by JavaScript | see §7 | Renaming breaks client-rendered markup **silently, with no build error**. |
| `migrations/`, `src/lib/`, `src/pages/api/` | — | This is a CSS migration. No behaviour changes. |
| `FEATURE_FLAGS` and any auth / officer gate | — | Same reason. |
| Media queries generally | everywhere | See §4 — breakpoints are deliberately **excluded** from this pass. |

### Rules

1. **CSS only.** Do not reformat, restructure or "tidy" markup while migrating styles. If markup
   must change (adding a class), change only that.
2. **One page per commit.** Never batch pages.
3. **Delete as you go.** A migration that adds the shared class but leaves the local rule behind
   has made things worse. See the §8 definition of done.
4. **No new values.** If you need a size, spacing or color that isn't in §1, stop and ask.
5. **Never invent a token name.** The full set is in §1. It is closed.

---

## 1. Tokens (Tranche 1)

Replace the `:root` block at `src/layouts/Layout.astro:287` with exactly this. **Purely additive**
— every existing token keeps its current value, so nothing renders differently.

Note `html { font-size: 18px }` (`Layout.astro:321`), so `1rem` = 18px. Do not change that.

```css
:root {
	color-scheme: dark;

	/* ── Brand ──────────────────────────────────────────────────── */
	--gold-rgb: 214 176 106;          /* #d6b06a as channels, so alphas derive */
	--gold: #d6b06a;
	--gold-bright: #e9c987;
	--steel: #8ca7bb;

	/* ── Text ───────────────────────────────────────────────────── */
	--text: #ebf1f5;
	--muted: #afc1cd;
	--text-faint: rgb(175 193 205 / 0.62);

	/* ── Base backgrounds (unchanged) ───────────────────────────── */
	--bg: #050b12;
	--bg-soft: #101a25;
	--bg-panel: rgba(13, 23, 34, 0.78);

	/* ── Surfaces — replaces the 186 one-off dark fills ─────────── */
	--surface: rgb(7 14 22 / 0.85);
	--surface-raised: rgb(15 28 43 / 0.88);
	--surface-sunken: rgb(5 10 16 / 0.55);
	--surface-hover: rgb(var(--gold-rgb) / 0.08);
	--surface-active: rgb(var(--gold-rgb) / 0.14);
	--surface-zebra: rgb(var(--gold-rgb) / 0.03);

	/* ── Borders — --border keeps its current 0.4, so this is safe ─ */
	--border-subtle: rgb(var(--gold-rgb) / 0.12);
	--border-soft: rgb(var(--gold-rgb) / 0.2);
	--border: rgb(var(--gold-rgb) / 0.4);
	--border-strong: rgb(var(--gold-rgb) / 0.55);

	/* ── State ──────────────────────────────────────────────────── */
	--success: #6ec26e;
	--success-bg: rgb(0 180 80 / 0.12);
	--warning: #e0b155;
	--warning-bg: rgb(224 177 85 / 0.12);
	--danger: #f47e7e;
	--danger-bg: rgb(244 126 126 / 0.12);
	--info: var(--steel);
	--info-bg: rgb(140 167 187 / 0.12);

	/* ── WoW item quality — Blizzard's values. Never change. ─────── */
	--quality-poor: #9d9d9d;
	--quality-common: #ffffff;
	--quality-uncommon: #1eff00;
	--quality-rare: #0070dd;
	--quality-epic: #a335ee;
	--quality-legendary: #ff8000;
	--quality-artifact: #e6cc80;

	/* ── Focus ──────────────────────────────────────────────────── */
	--focus-ring: 0 0 0 2px rgb(var(--gold-rgb) / 0.75);
	--focus-ring-offset: 1px;

	/* ── Type scale — see §2 for the mapping ────────────────────── */
	--text-2xs: 0.65rem;              /* 11.7px */
	--text-xs: 0.72rem;               /* 13.0px */
	--text-sm: 0.8rem;                /* 14.4px */
	--text-base: 0.9rem;              /* 16.2px — default body */
	--text-lg: 1.05rem;               /* 18.9px */
	--text-xl: 1.25rem;               /* 22.5px */
	--text-2xl: 1.6rem;               /* 28.8px */
	--text-3xl: 2.2rem;               /* 39.6px */
	--text-display: clamp(2rem, 3.1vw, 2.95rem);

	--leading-tight: 1.2;
	--leading-normal: 1.45;
	--leading-loose: 1.65;

	/* ── Space scale — see §3 for the mapping ───────────────────── */
	--space-1: 0.15rem;               /* 2.7px */
	--space-2: 0.25rem;               /* 4.5px */
	--space-3: 0.4rem;                /* 7.2px */
	--space-4: 0.5rem;                /* 9.0px */
	--space-5: 0.75rem;               /* 13.5px */
	--space-6: 1rem;                  /* 18px */
	--space-7: 1.5rem;                /* 27px */
	--space-8: 2.5rem;                /* 45px */

	/* ── Radius — see §4 ────────────────────────────────────────── */
	--radius-xs: 0.25rem;
	--radius-sm: 0.35rem;
	--radius-md: 0.45rem;
	--radius-lg: 0.6rem;
	--radius-xl: 0.8rem;
	--radius-pill: 999px;
	--radius-circle: 50%;

	/* ── Elevation ──────────────────────────────────────────────── */
	--shadow-sm: 0 4px 12px rgb(0 0 0 / 0.2);
	--shadow-md: 0 10px 28px rgb(0 0 0 / 0.28);
	--shadow-lg: 0 14px 30px rgb(0 0 0 / 0.35);

	/* ── Motion ─────────────────────────────────────────────────── */
	--transition-fast: 140ms ease;
	--transition-base: 200ms ease;

	/* ── Fonts (unchanged) ──────────────────────────────────────── */
	--font-display: 'Cinzel', Georgia, 'Times New Roman', serif;
	--font-body: 'Barlow Condensed', 'Trebuchet MS', sans-serif;
}
```

**Admin palette override** — add to `src/layouts/AdminLayout.astro`'s scoped style. This is how
admin keeps its warmer tint (settled decision 2) while using the same primitives as everywhere
else:

```css
.admin-wrapper {
	--surface: rgb(20 10 2 / 0.55);
	--surface-raised: rgb(30 14 4 / 0.6);
	--surface-sunken: rgb(12 8 2 / 0.75);
}
```

**Verify tranche 1:** `npm run build`, then confirm `dist/_astro/*.css` still contains a bare
`:root{`. Nothing should look different. If anything does, a token value was changed rather than
added — revert and retry.

---

## 2. Type scale mapping (Tranche 2)

**Every** `font-size` in the codebase maps to exactly one token. Find the current value in the
left column, replace with the token. There are no other options.

| Current values | → Token | New value |
|---|---|---|
| `0.55` `0.6` `0.62` `0.64` `0.65` `0.66` `0.68` | `--text-2xs` | 0.65rem |
| `0.69` `0.7` `0.71` `0.72` `0.73` `0.74` `0.75` `0.76` | `--text-xs` | 0.72rem |
| `0.78` `0.79` `0.8` `0.82` `0.83` `0.84` | `--text-sm` | 0.8rem |
| `0.85` `0.86` `0.875` `0.88` `0.9` `0.92` `0.93` `0.94` `0.95` `0.96` `0.97` | `--text-base` | 0.9rem |
| `0.975` `0.98` `1` `1.01` `1.02` `1.03` `1.05` `1.06` `1.08` `1.1` `1.12` `1.15` | `--text-lg` | 1.05rem |
| `1.16` `1.2` `1.22` `1.25` `1.3` `1.35` | `--text-xl` | 1.25rem |
| `1.4` `1.5` `1.6` `1.75` | `--text-2xl` | 1.6rem |
| `2` `2.1` `2.2` `2.6` | `--text-3xl` | 2.2rem |
| every `clamp(...)` used on an `h1` | `--text-display` | clamp(2rem, 3.1vw, 2.95rem) |
| `16px` `18px` `20px` `22px` | convert to rem first, then map | — |
| `0.7em` `0.72em` | **leave alone** | relative to parent on purpose |

That's 58 distinct values to 9 steps. Expect small shifts — `0.82rem` (49 uses) shrinks 0.36px,
`0.85rem` (40 uses) grows 0.9px. **That is the intended outcome, not a regression.**

### Global base styles

Create `src/styles/base.css` and import it from `Layout.astro`'s frontmatter
(`import '../styles/base.css';`). Astro treats imported CSS as global — this is the mechanism the
whole migration depends on.

```css
body {
	font-size: var(--text-base);
	line-height: var(--leading-normal);
}

h1, h2, h3, h4 {
	font-family: var(--font-display);
	letter-spacing: 0.04em;
	line-height: var(--leading-tight);
}

h1 { font-size: var(--text-3xl); }
h2 { font-size: var(--text-2xl); }
h3 { font-size: var(--text-xl); }
h4 { font-size: var(--text-lg); }

/* Uppercase label treatment — recurs constantly with drifting values. */
.label {
	font-size: var(--text-sm);
	text-transform: uppercase;
	letter-spacing: 0.06em;
	color: var(--muted);
}

:focus-visible {
	outline: none;
	box-shadow: var(--focus-ring);
	border-radius: var(--radius-xs);
}
```

Then delete `:global(h1), :global(h2), :global(h3)` from `Layout.astro:324` — `base.css` replaces it.

**This changes the 20 pages that render a bare `<h1>`** (they currently fall through to the UA
default 2em/36px, now 2.2rem/39.6px). That is the point of the item. While here, also fix the
homepage's missing `<h1>` — `TODO.md` security item 4.

---

## 3. Space scale mapping (Tranche 5)

Applies to `gap`, `padding`, `margin`. Nearest-step, no exceptions.

| Current values | → Token | New value |
|---|---|---|
| `0.05` `0.08` `0.1` `0.12` `0.15` `0.16` `0.18` `0.19` | `--space-1` | 0.15rem |
| `0.2` `0.22` `0.24` `0.25` `0.26` `0.28` `0.3` `0.32` | `--space-2` | 0.25rem |
| `0.35` `0.36` `0.38` `0.4` `0.42` `0.45` `0.48` | `--space-3` | 0.4rem |
| `0.5` `0.55` `0.58` `0.6` `0.62` | `--space-4` | 0.5rem |
| `0.65` `0.7` `0.72` `0.75` `0.78` `0.8` `0.85` | `--space-5` | 0.75rem |
| `0.9` `1` `1.05` `1.1` `1.2` | `--space-6` | 1rem |
| `1.25` `1.4` `1.5` `1.75` `2` | `--space-7` | 1.5rem |
| `2.2` `2.5` and above | `--space-8` | 2.5rem |

`0` stays `0`. Percentages, `auto`, `vh`/`vw` and `calc()` are left alone.

## 4. Radius and breakpoints

| Current values | → Token | New value |
|---|---|---|
| `0.16` `0.2` `0.25` `0.28` `2px` `3px` `4px` | `--radius-xs` | 0.25rem |
| `0.3` `0.32` `0.35` `0.375` `6px` | `--radius-sm` | 0.35rem |
| `0.4` `0.42` `0.45` `8px` | `--radius-md` | 0.45rem |
| `0.5` `0.55` `0.6` `0.62` `0.65` `10px` | `--radius-lg` | 0.6rem |
| `0.7` `0.75` `0.8` `0.85` `0.9` `16px` | `--radius-xl` | 0.8rem |
| `999px` | `--radius-pill` | 999px |
| `50%` | `--radius-circle` | 50% |

Multi-value radii (`0.7rem 0.7rem 0 0`) map each component independently.

### Breakpoints are excluded from this pass — deliberately

The audit counted 26. **Do not consolidate them.** Snapping a breakpoint changes *when* a layout
reflows, which is a behaviour change, not a styling one — and the nav breakpoints were the subject
of the last two bug-fix releases.

The rule going forward: **new** code uses `560px` / `768px` / `900px` / `1100px` / `1310px`.
Existing media queries are left exactly as they are until someone is working on that page's
responsive behaviour deliberately, with a browser open.

---

## 5. Primitives (Tranche 3)

Create `src/styles/components.css`, import it from `Layout.astro` after `base.css`. Nothing
references these until tranche 4, so this tranche cannot change how anything renders.

The audit found four table implementations and five button implementations. **The winners are
resolved below.** Do not average them, do not re-derive them.

```css
/* ═══ Tables ═══════════════════════════════════════════════════════
   Resolved from 4 implementations. Base shape is roster/raiders (the
   copy-paste pair, and the two biggest tables). Divider is
   border-bottom (3 of 4 agreed). death-analysis's border-top loses. */

.table-wrap {
	overflow-x: auto;
}

.data-table {
	width: 100%;
	border-collapse: collapse;
	min-width: var(--table-min, 0);
}

.data-table th,
.data-table td {
	padding: var(--space-4) var(--space-5);
	border-bottom: 1px solid var(--border-subtle);
	text-align: left;
	font-size: var(--text-base);
	color: var(--text);
}

.data-table thead th {
	position: sticky;
	top: 0;
	z-index: 1;
	background: var(--surface-raised);
	font-size: var(--text-sm);
	text-transform: uppercase;
	letter-spacing: 0.06em;
	color: var(--muted);
	white-space: nowrap;
}

.data-table tbody tr:hover {
	background: var(--surface-hover);
}

.data-table--zebra tbody tr:nth-child(even) {
	background: var(--surface-zebra);
}

.data-table--compact th,
.data-table--compact td {
	padding: var(--space-3) var(--space-4);
	font-size: var(--text-sm);
}

.data-table--top th,
.data-table--top td {
	vertical-align: top;
}

/* Sort button — resolved to the loot-history / death-analysis variant.
   The roster variant loses: it gives no indication a column is sortable. */
.sort-btn {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	padding: 0;
	margin: 0;
	border: 0;
	background: transparent;
	color: inherit;
	font: inherit;
	text-transform: inherit;
	letter-spacing: inherit;
	cursor: pointer;
}

.sort-btn::after { content: '\2195'; opacity: 0.5; font-size: var(--text-xs); }
.sort-btn.is-asc::after { content: '\2191'; opacity: 1; }
.sort-btn.is-desc::after { content: '\2193'; opacity: 1; }

/* ═══ Buttons ══════════════════════════════════════════════════════
   Resolved from 5 implementations. Radius from roster-teams (0.45rem
   is also the most common radius in the codebase, 58 uses).
   Case: NORMAL — 3 of 5 agreed. The two uppercase variants lose. */

.btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: var(--space-2);
	padding: var(--space-3) var(--space-5);
	border: 1px solid transparent;
	border-radius: var(--radius-md);
	font-family: var(--font-body);
	font-size: var(--text-sm);
	font-weight: 600;
	line-height: 1;
	white-space: nowrap;
	cursor: pointer;
	background: transparent;
	color: var(--text);
	transition: background var(--transition-fast), border-color var(--transition-fast),
		color var(--transition-fast);
}

.btn:disabled,
.btn[aria-disabled='true'] {
	opacity: 0.5;
	cursor: not-allowed;
}

.btn--primary {
	background: var(--surface-active);
	border-color: var(--border-strong);
	color: var(--gold-bright);
}
.btn--primary:hover:not(:disabled) { background: rgb(var(--gold-rgb) / 0.22); }

.btn--secondary { border-color: var(--border-soft); color: var(--muted); }
.btn--secondary:hover:not(:disabled) { border-color: var(--border); color: var(--text); }

.btn--danger { background: var(--danger-bg); border-color: var(--danger); color: var(--danger); }
.btn--subtle { color: var(--muted); }
.btn--subtle:hover:not(:disabled) { background: var(--surface-hover); color: var(--text); }

.btn--sm { padding: var(--space-2) var(--space-3); font-size: var(--text-xs); }
.btn--lg { padding: var(--space-4) var(--space-6); font-size: var(--text-base); }

/* ═══ Surfaces ═════════════════════════════════════════════════════ */

.card {
	background: var(--surface-raised);
	border: 1px solid var(--border-soft);
	border-radius: var(--radius-lg);
	padding: var(--space-6);
	box-shadow: var(--shadow-sm);
}

.card--interactive { transition: border-color var(--transition-fast), background var(--transition-fast); }
.card--interactive:hover { border-color: var(--border); background: var(--surface-hover); }
.card--flush { padding: 0; overflow: hidden; }

/* Gold top edge: OPT-IN, not the house style. It is currently a
   one-page flourish (SectionCard) and making it the default would
   change ~30 cards. */
.card--accent { position: relative; overflow: hidden; }
.card--accent::before {
	content: '';
	position: absolute;
	inset: 0 0 auto 0;
	height: 0.18rem;
	background: linear-gradient(90deg, rgb(var(--gold-rgb) / 0.1),
		rgb(var(--gold-rgb) / 0.8), rgb(var(--gold-rgb) / 0.1));
}

/* ═══ Page chrome ══════════════════════════════════════════════════ */

.page-header {
	display: flex;
	justify-content: space-between;
	align-items: flex-start;
	flex-wrap: wrap;
	gap: var(--space-6);
	margin-bottom: var(--space-7);
}

.page-header h1 { margin: 0 0 var(--space-2); }
.page-desc { margin: 0; color: var(--muted); font-size: var(--text-base); }

.empty-state {
	margin: 0;
	color: var(--muted);
	font-style: italic;
	font-size: var(--text-base);
}

.pill {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	padding: var(--space-1) var(--space-3);
	border: 1px solid var(--border-soft);
	border-radius: var(--radius-pill);
	font-size: var(--text-xs);
	white-space: nowrap;
}
```

### `PageHeader.astro`

The one new component (settled decision 3). Create `src/components/PageHeader.astro`:

```astro
---
interface Props { title: string; description?: string; }
const { title, description } = Astro.props;
---
<div class="page-header">
	<div>
		<h1>{title}</h1>
		{description && <p class="page-desc">{description}</p>}
	</div>
	<slot name="actions" />
</div>
```

Styles live in `components.css`, not here — a scoped block would not reach pages that use the bare
class during migration.

### Retire `SectionCard.astro`

Used twice, both on `index.astro`. Replace both with `<article class="card card--accent">` and
delete the component. Do this as part of `index.astro`'s migration.

---

## 6. Button one-off mapping (Tranche 4)

The ~25 bespoke button classes collapse as follows. Classes on the right that carry **semantic
state** keep a modifier; the rest are plain variants.

| Existing | → |
|---|---|
| `btn-primary` `btn-submit` `btn-confirm-exclude` `btn-add-note` `btn-set-main` `btn-set-status` | `btn btn--primary` |
| `btn-secondary` `btn-edit-note` `btn-edit-cancel` `btn-cancel` `btn-prev` `btn-next` | `btn btn--secondary` |
| `btn-danger` `btn-delete` `btn-delete-note` `btn-delete-app` `btn-remove-char` `btn-exclude` | `btn btn--danger` |
| `btn-subtle` `btn-note` | `btn btn--subtle` |
| `btn-sm` `btn-mini` `btn-compact` | `btn btn--sm` |
| `button--inline` `button--aside` | `btn btn--secondary` |
| `btn-sign` | `btn btn--sign` — **keep**, encodes signup state (green) |
| `btn-tentative` | `btn btn--tentative` — **keep**, amber |
| `btn-late` | `btn btn--late` — **keep**, red |

The three kept modifiers go in `components.css` driven off `--success` / `--warning` / `--danger`,
replacing their current hardcoded greens and reds.

---

## 7. Client-rendered class names — read before tranche 4

Three pages build markup in JavaScript. A class rename there **fails silently at runtime with no
build error**, which is the single most likely way to break this migration.

| File | Risk |
|---|---|
| `src/components/RaiderSimTools.astro` | Builds table rows via `innerHTML`. Most table CSS in the repo (15 rules). |
| `src/pages/raid-composition.astro` | 59 `:global()` escapes; chips built and mutated in JS; drag-and-drop. |
| `src/pages/death-analysis.astro` | 12 `:global()` escapes; `.cd-chip` cooldown chips fetched and injected. |

Procedure for these three, and only these three:

1. `grep` the page's `<script>` blocks for every class string before changing any CSS.
2. Their `:global()` rules **move into `components.css` as-is first**, in a separate commit, with
   no renaming. They are already global in effect, so this is a no-op you can verify.
3. Only then rename, updating the JS string and the CSS in the same commit.
4. Exercise the actual interaction in a browser — sort a column, drag a chip, expand a death row.
   A page that renders correctly on load can still be broken.

These three go **last**. By then the primitives will have been exercised on ~20 simpler pages.

---

## 8. Per-page migration procedure (Tranche 4)

Run this for one page, commit, then start the next. Do not batch.

1. **Before:** `npm run dev`, open the page, screenshot it. Check logged-out *and* logged-in views
   if the page renders differently for each.
2. Read the page's entire `<style>` block first. Note anything that is genuinely page-specific
   (grid placement, class coloring, animations) — that **stays**.
3. Add the shared classes to the markup (`class="data-table"`, `class="btn btn--primary"`, …).
4. Delete the local rules that the shared class now covers. Scoped rules have higher specificity
   than global ones, so **until you delete them nothing changes** — which means if the page looks
   different at this step, you deleted something the primitive doesn't cover. Put it back as a
   page-specific rule.
5. Map remaining local values to tokens using §2, §3, §4.
6. Delete any now-empty rule or `<style>` block.
7. `npm run typecheck` — must stay at 0 errors / 0 warnings. `astro check`'s unused-selector hints
   are useful here for spotting CSS left behind.
8. **After:** screenshot and compare against step 1.
9. Commit: `Style: migrate <page> to design system primitives`.

### Definition of done for a page

- [ ] No `rgba(214, 176, 106, …)` remains in the file
- [ ] No raw `font-size` — every one is a `var(--text-*)`
- [ ] No local `.btn`, `.empty-state`, `.page-header`, `.sort-btn`, `.table-wrap` or `*-table`
      definition remains
- [ ] `*-card` classes either removed in favour of `.card`, or reduced to layout-only rules
- [ ] `npm run typecheck` clean
- [ ] Screenshots compared; differences are explainable as intended snap shifts

### What "explainable" means

After tranche 2, **every page shifts slightly** — that's decision 1. So "did anything move?" is not
the check. The check is:

- Does text still fit its container, with no new wrapping or overflow?
- Do dense tables (`roster`, `raiders`, `loot-history`) still fit without new horizontal scroll?
- Is the visual hierarchy intact — are headings still larger than body, labels still smaller?
- Did any interactive element lose its hover or focus state?

A "no" to any of those is a real regression. Anything else is the migration working.

---

## 9. Page order (Tranche 4)

Cheapest first, so the primitives are exercised before they meet the hard pages. Roughly in
ascending order of CSS size.

**Group A — warm-up (under 200 lines CSS each)**
`404` · `privacy` · `hiatus` · `feedback` · `articles/index` · `admin/feedback`

**Group B — simple pages**
`links` · `leadership` · `admin/log-matching` · `RaiderSimRecommendations` · `Welcome`

**Group C — admin (shares the most structure; migrate as a run)**
`admin/applications` · `admin/settings` · `admin/raid-signups` · `admin/raiding` ·
`admin/mains` · `admin/roster-teams`

**Group D — tables**
`professions` · `trinkets` · `roster` · `raiders` · `raiders/gear-summary` · `loot-history` ·
`mechanics-analysis`

**Group E — large**
`index` (retire `SectionCard` here) · `profile` · `lore` · `upgrades` · `raiding` ·
`RaiderRaidbotsReports`

**Group F — hard, see §7. One session each.**
`signup` (1,168) · `death-analysis` (449 + 12 globals) · `raiders/[charId]` (1,335) ·
`raid-composition` (1,089 + 59 globals) · `RaiderSimTools` (475 + innerHTML)

**Before starting Group F**, confirm no feature work is in flight on `raid-composition` — v2.25
through v2.27 all touched it.

---

## 10. Guardrail (Tranche 6)

Add to `package.json`: `"lint:css": "node scripts/check-css.mjs"`.

The script fails the build if it finds, anywhere in `src/**/*.astro`:

1. `rgba(214, 176, 106, …)` — use `rgb(var(--gold-rgb) / …)` or a semantic token
2. A `font-size` with a literal value (allow `var(--text-*)`, `inherit`, `em` units, `clamp()` in
   `base.css`)
3. A definition of `.btn`, `.empty-state`, `.page-header`, `.sort-btn`, `.table-wrap` or
   `.data-table` outside `src/styles/`
4. A `border-radius` with a literal `px` value

Grep-based is fine — this doesn't need a CSS parser. Report file and line; exit non-zero on any hit.

Then document the system in `AGENTS.md`: where tokens live, where the stylesheets live, the Astro
scoping constraint from §5, and "use the primitive, don't redefine it." Update `README.md` and the
Vault Hidden Lodge notes per the usual docs-upkeep rule.

---

## 11. Progress

Tick as tranches land.

- [x] **1** — Tokens into `Layout.astro:287` + admin override (§1). *S, zero risk*
- [x] **2** — `src/styles/base.css`, type scale, global focus (§2). *M*
- [ ] **3** — `src/styles/components.css`, `PageHeader.astro` (§5). *M, nothing references it yet*
- [ ] **4** — Page migrations (§6–§9). *L — the bulk of the work*
  - [ ] Group A  - [ ] Group B  - [ ] Group C  - [ ] Group D  - [ ] Group E  - [ ] Group F
- [ ] **5** — Space/radius snap across remaining files (§3, §4). *M*
- [ ] **6** — `lint:css` + docs (§10). *S*
