# Web UI design reference

The two browser UIs — **lead** (the review deck, served by `src/server`) and
**prospect** (the control panel, served by `src/control`) — follow the Langfuse
design language, taken from the site source checked in under `langfuse/`. This
file is the contract for later changes; it replaces the retired "Deck design"
section of `docs/ARCHITECTURE.md`.

Adopt the language, not the brand: no Langfuse name, logo or wordmark appears
anywhere. Licence notices are in `web/THIRD_PARTY.md`.

## Stack

| | |
|---|---|
| Build | Vite 8, one config (`web/vite.config.ts`), `--mode lead` / `--mode prospect` |
| UI | React 19 + TypeScript, strict |
| Styles | Tailwind CSS v4 via `@tailwindcss/vite`; tokens in `web/ui/tokens.css` |
| Icons | `lucide-react` |
| Output | `web/dist/lead/`, `web/dist/prospect/` — `index.html` + `assets/<name>-<hash>.<ext>` |

No UI framework beyond React: controls are native `<button>`, `<select>`,
`<textarea>`, `<dialog>` styled with the tokens. That keeps both bundles small,
keeps the phone's native pickers, and leaves nothing to pin but React itself.

Every dependency is pinned to an exact version in `web/package.json`. The apps
make no request to any host but their own: fonts are bundled, there is no CDN,
no analytics, no tracker, no `<link rel=preconnect>`.

## Tokens (`web/ui/tokens.css`)

Names match `langfuse/style.css` so a value can be traced to its source. Dark
mode follows `prefers-color-scheme`; nothing is stored.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--surface-1` | `#edede8` | `#1e1e1b` | the page |
| `--surface-bg` | `#f6f6f3` | `#171714` | panels, cards, inputs (lighter than the page in light mode) |
| `--surface-2` | `#e5e5e1` | `#252522` | pressed / selected fills, progress track |
| `--surface-code` | `#333333` | `#0e0e0c` | the live log |
| `--surface-cta-primary` | `#fbff81` | `#4c4d23` | the one yellow: primary call-to-action fill |
| `--surface-key` | `rgba(64,61,57,.10)` | `rgba(184,182,160,.12)` | keycap chips |
| `--line-structure` | `#cfcfc9` | `#2c2c29` | every border |
| `--line-divider-dash` | `#bebeb6` | `#232320` | dashed row rules |
| `--line-cta` | `#404039` | `#b8b6a0` | corner brackets, focus ring, emphasised border |
| `--text-primary` | `#222220` | `#e8e8e4` | headings, values |
| `--text-secondary` | `#3d3d38` | `#b4b4ae` | labels, body |
| `--text-tertiary` | `#6b6b66` | `#7a7a74` | captions, hints |
| `--text-disabled` | `#a7a7a0` | `#4a4a45` | placeholders, disabled |
| `--text-links` | `#4f39f6` | `#7b8ff8` | outside links |
| `--tone-success/warning/error/info` | `#538a2e` `#e09d00` `#cc3314` `#b3abef` | lighter | **pipeline and connection state only** |

Tailwind utilities read them as `bg-surface-bg`, `text-text-tertiary`,
`border-line-structure`, `bg-tone-error`, and so on.

**Colour never grades a lead.** The tones are for the control panel's run state
and connection dot, and for "not saved" toasts. Evidence on a lead — HTTP only,
cert expired, has email — is shown as a neutral outline badge, and a tier is a
letter in a pressed chip. There is no red for "bad site" and no green for "good
lead", because the UI has no opinion.

### Type

| Role | Face | Size / weight |
|---|---|---|
| Headings | IBM Plex Serif (substitute for F37 Analog) | 32 px / 500, 15 px / 500 for panel titles |
| Labels, buttons, tabs | Inter | 12 px / 450, tracking −0.06 px |
| Body | Inter | 14 px / 430 (`text-body-s`), 15 px / 400 (`text-body-m`) |
| Numbers, domains, log, keycaps, tooltips | Geist Mono | 10–13 px, `tabular-nums` |

### Shape and motion

- Radius **2 px** on inputs and buttons (`rounded-ctl`), 1 px on tabs
  (`rounded-tab`). Nothing is pill-shaped except a status dot.
- Panels are a 1 px `line-structure` border on `surface-bg` with **8×8 corner
  brackets** (`.corner-box`), drawn by a masked `::before`. Interactive boxes
  show the brackets on hover, focus and when current (`.corner-box-hover`).
- **Diagonal stripes** (`.stripes`, `.stripes-hover`) mark a hovered card or a
  pending region.
- Shadows: one soft control shadow (`shadow-ctl`) on buttons; none elsewhere.
- Motion: 120–200 ms colour and opacity transitions only. Every animation is
  disabled under `prefers-reduced-motion`.
- Focus: a 2 px `line-cta` outline with 2 px offset, never removed.

## Component inventory (`web/ui/`)

| Component | Notes |
|---|---|
| `Button` | `primary` (dark fill, or `cta` yellow), `secondary` (bordered), `text`; sizes 26 / 32 px; optional `Keycap` hint |
| `Keycap` | 20×20 mono chip that names a key; the visible half of every shortcut |
| `Badge` | outline, neutral. Evidence, not judgement |
| `Panel` | corner-bracket box with optional title row |
| `Tabs` | `role=tablist`, arrow-key movable, 26 px triggers |
| `Chip` | filter toggle with `aria-pressed` |
| `TierGroup` | `role=radiogroup` of four `role=radio` buttons; pressing the checked one clears |
| `Field`, `Select`, `Textarea`, `Input` | labelled native controls |
| `Dialog` | native `<dialog>` confirm with focus trap; used wherever spend or a stop needs a yes |
| `Toast` | bottom-centre, `role=status`; the "not saved — …" revert message |
| `StatTile` | number + label, `tabular-nums` |
| `StackedBar` | captured / failed / pending proportions |
| `Empty`, `ErrorState`, `Spinner`, `Skeleton` | the three non-happy states every view has |

## Keyboard map (lead)

No shortcut fires while an input or textarea has focus, except **Esc**, which
blurs it. Every key has a visible, clickable equivalent and a keycap hint.

| Key | Action |
|---|---|
| → / J | next lead in the current filtered list (crosses page boundaries) |
| ← / K | previous lead |
| A B C X, 1 2 3 4 | set tier; the same key again clears it |
| P | toggle pitch |
| N | focus the note; Esc blurs it |
| D / M | desktop / mobile screenshot |
| U | next unreviewed lead |
| O | open the live site in a new tab (`noopener`) |
| Esc | detail → grid → overview |
| ? | keyboard help overlay |

Stepping follows the current vertical, tab and filter order as the server
returns it. Passing the last loaded row fetches the next `offset` page; the
neighbours' detail and screenshots are prefetched so a step feels instant.

## Routes

Both apps use **hash routes**, so the servers need no history fallback and every
existing bookmark keeps working.

lead: `#/` overview · `#/v/<slug>[/no-website][?filter=a,b]` vertical ·
`#/lead/<id>[?filter=…&from=<slug>]` detail.

prospect: `#progress` · `#run` · `#new` · `#log`.

## Serving

`src/server/static.js` serves a build directory for both servers: `/assets/*`
is `Cache-Control: public, max-age=31536000, immutable` (the names are
content-hashed), `index.html` is `no-cache`, everything else is `no-cache`
too, unknown files are 404, and nothing outside the directory is reachable.
`/api/*` and `/shots/*` are routed before static and are never shadowed.
