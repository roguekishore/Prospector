# HANDOFF — Langfuse-style redesign of the two web UIs

You are redesigning Prospector's two browser UIs, **lead** (the review deck) and
**prospect** (the control panel), as new front ends that follow the design
system in `langfuse/`. All of this work happens on the branch **`langfuse`**,
and only there.

Read this whole file before you touch anything. Section 1 is not optional.

---

## 1. Branch safety — do this before any work, every session

This clone is shared with other work. `main` belongs to someone else and must
never change because of you.

### 1.1 Preflight

```sh
git fetch origin
git switch langfuse                       # never `git checkout main`
test "$(git rev-parse --abbrev-ref HEAD)" = "langfuse" || { echo "STOP: not on langfuse"; exit 1; }
git status --short                        # must print nothing; if it does, stop and report
git pull --ff-only origin langfuse        # fast-forward only; if it refuses, stop and report
test -f HANDOFF.md || { echo "STOP: HANDOFF.md missing, wrong branch or stale clone"; exit 1; }
```

If any line fails, **stop and report**. Don't try to fix the branch yourself.

### 1.2 Install two local guard hooks (they are not tracked, so do this once per clone)

`.git/hooks/pre-commit`:

```sh
#!/bin/sh
b=$(git rev-parse --abbrev-ref HEAD)
[ "$b" = "langfuse" ] || { echo "refusing to commit on '$b': this work belongs on langfuse" >&2; exit 1; }
```

`.git/hooks/pre-push`:

```sh
#!/bin/sh
while read local_ref local_sha remote_ref remote_sha; do
  [ "$remote_ref" = "refs/heads/langfuse" ] || { echo "refusing to push to $remote_ref" >&2; exit 1; }
done
```

Then `chmod +x .git/hooks/pre-commit .git/hooks/pre-push`.

### 1.3 Hard rules

- Re-run the branch check (`git rev-parse --abbrev-ref HEAD` must print `langfuse`)
  before every commit and every push.
- Never check out, merge into, rebase onto, reset, or push `main`. Never open a PR
  unless the operator asks. Never create, delete or rename branches.
- Never `push --force`, `reset --hard`, `clean -fd`, `commit --amend` on pushed
  commits, or `--no-verify`.
- Push only as `git push origin langfuse`. Push at the end of every phase (§7).
- Never commit `.env`, `data/`, `node_modules/`, credentials, or screenshots of
  real leads.

### 1.4 Commit granularly

One logical change per commit, conventional-commit style as used in this repo
(`git log --oneline` shows the existing style):

- `build(web): scaffold lead app with vite + tailwind`
- `feat(lead): card grid with filter chips`
- `feat(lead): keyboard stepping across page boundaries`
- `refactor(server): serve the built lead app instead of preview/`
- `test(deck): assert the new asset routes`
- `docs: deck design section describes the langfuse system`

Every commit must leave the build and `npm run test:deck` green. Per `CLAUDE.md`,
update `docs/STATUS.md` in the same commit as the change it describes.

---

## 2. What is free and what is locked

### 2.1 Free: you decide

- **Design.** You are not bound to the current look. `preview/app.css` and the
  "Deck design" rules in `docs/ARCHITECTURE.md` (monochrome, no colour,
  four opacity steps) are **retired** for this work. Follow the Langfuse design
  language, and beyond that make whatever layout, motion, density, dark/light
  and interaction choices serve the operator best.
- **Framework and toolchain.** Vite, React, Preact, Svelte, Solid, Tailwind v4,
  shadcn/Radix, anything. `langfuse/` is Next.js + Tailwind v4 + shadcn-style
  components in `langfuse/components/ui/`, so React + Tailwind + Radix ports most
  directly, but the choice is yours. Pin every dependency to an exact version.
- **Serving logic.** You may rewrite how both servers serve their front ends
  (static dir, SPA fallback, hashed assets, cache headers, compression), and the
  build/ship wiring that gets built assets onto the box. §5 lists exactly what
  has to change. **Making serving and deploy work is part of your job, not an
  optional extra.** A redesign that only works on `vite dev` is not done.
- **New client-side features** built on the existing API: keyboard control,
  command palette, prefetching, split views, zoomable screenshots, help overlay,
  and so on.

### 2.2 Locked: do not change

- **Schema and data.** `db/migrations/`, `docs/SCHEMA.md`, every table and
  column. No new migration.
- **Pipeline and backend logic.** `src/discover`, `src/qualify`, `src/capture`,
  `src/ingest`, `src/db`, `src/cli`, `scripts/dispatch.js`, `lib-keys.js`,
  `terraform/`, `Dockerfile.capture`, the Lambda.
- **The API contract of both servers.** Every route, method, parameter,
  validation rule, SQL query, response shape, status code, SSE event name and
  payload, as listed in §4. The front ends adapt to the API, never the reverse.
- **Auth semantics.** Both servers bind `127.0.0.1` (control binds `0.0.0.0`
  only when `CONTROL_TOKEN` is set); Caddy `basic_auth` is the public gate;
  control's `/api/*` stays behind `authorised()`.
- **No scoring, ever** (`CLAUDE.md`). The UI must not compute, suggest, rank,
  colour-code or badge any judgement of a lead: no "lead score", "hot lead",
  "AI insight" or sort-by-quality. It shows evidence and stores the operator's
  own tier/pitch/note. Sorting stays as the server returns it.

If a design genuinely cannot work without a backend change, **don't make it**.
Add it under "Open requests" at the bottom of this file, commit that, and build
the best version you can without it.

---

## 3. The two UIs today

| | lead (review deck) | prospect (control panel) |
|---|---|---|
| Public host | `leads.themaverick.tech` (`deploy/Caddyfile.leads`) | `prospect.themaverick.tech` (`deploy/Caddyfile.prospect`) |
| Server | `src/server/index.js`, `npm run serve`, `127.0.0.1:7777` | `src/control/index.js`, `npm run control`, `:7778` |
| Front end today | `preview/index.html`, `app.js`, `app.css` | `src/control/ui.html` (one file, inline CSS/JS) |
| Used from | desktop, long review sessions | often a phone |

Both front ends are vanilla JS with no build step. Both are replaced in full.

### 3.1 lead: the feature list your version must cover (parity, then better)

- **Overview:** every vertical with `leads`, `no_website`, `reviewed`, `pitch`
  counts and % reviewed.
- **Vertical view:** filter chips that combine with AND: `http`, `expired`,
  `email`, `unreviewed`, `pitch`, `tier:A`, `tier:B`, `tier:C`, `tier:X`. A
  card grid showing the mobile screenshot, name, review count, rating, badges
  (HTTP only / cert expired / has email), the pitch pin and the operator's tier.
  Paging is 60 at a time, currently a "Load more" button.
- **No-website tab:** rows with `domain IS NULL` in a table, with the same
  decision controls per row.
- **Lead detail:** desktop and mobile screenshots (switchable), Places details
  (address, phone, rating, reviews, primary type, business status), HTTPS status
  and cert expiry, website_raw / final_url / http_status, email, captured_at,
  links grouped social / other (new tab, `rel="noopener noreferrer"`), tier
  picker A/B/C/X (pressing the current one clears it), pitch toggle, and a note
  (saved on blur, max 4,000 chars).
- **Pitch export:** download `/api/export/pitch.csv`.
- **Decisions are optimistic:** flip the UI first; if the `PUT` fails, revert
  and show a "not saved — …" toast. Never store a decision in `localStorage`.
  At most the last-opened vertical may be remembered.
- **Deep links:** the current app uses hash routes. Every view, filter set and
  lead must stay linkable and survive a refresh.
- **Escape every server string.** Framework templating does this; never
  `innerHTML`/`dangerouslySetInnerHTML` with API data.

### 3.2 lead: keyboard control (restore, then extend)

The rewrite in commit `ec424b1` (2026-09-26) accidentally dropped most keys. The
full set lived in `git show d654788:preview/app.js`; read its `keydown`
handler, `step()` and `nextUnreviewed()`. Required in the new deck:

| Key | Action |
|---|---|
| → / J | next lead in the current filtered list |
| ← / K | previous lead |
| A B C X and 1 2 3 4 | set tier (same key again clears it) |
| P | toggle pitch |
| N | focus the note (Esc blurs it) |
| D / M | desktop / mobile screenshot |
| U | next unreviewed lead |
| O | open the live site in a new tab (`noopener`) |
| Esc | detail → grid → overview |
| ? | keyboard help overlay |

- Stepping follows the current vertical, tab and filter order, and **crosses
  page boundaries**. When you step past the loaded rows, fetch the next
  `offset` page. Prefetch the neighbouring leads' detail and screenshots so a
  step feels instant.
- No shortcut fires while an input or textarea has focus, except Esc.
- Every key has a visible, clickable equivalent and a visible hint (keycaps,
  tooltips or a footer).

### 3.3 prospect: the feature list your version must cover

- **Auth plumbing:** the token comes from `?token=` or `localStorage['pc.token']`.
  Send it as the `X-Control-Token` header on fetches and as `?token=` on the
  `EventSource` URL. A 401 should show a clear "token needed" state, not an
  empty page.
- **Header:** a live connection indicator (SSE open or not) and the run state.
  An error banner for failures.
- **Progress:** totals (`discovered`, `eligible`, `captured`, `failed`,
  `pending`, `noWebsite`, `dead`, `unqualified`, `extracted`, `pct`), a stacked
  progress bar, `failureKinds` breakdown, and a per-vertical breakdown. Counts
  are **rows, not domains**, and the UI must say so. Status is pushed over SSE
  every 3 s while a tab is open.
- **Run:** mode local (this box, slow) or lambda (fast). Vertical select ("all"
  or one, showing pending count). Local: concurrency 1/2/4/8/16 (default 2) and
  deadline 60/90/120 s. Lambda: batch 5/10/15 (default 10; 15 is labelled
  risky). Start, and Stop with a confirm ("completed captures are kept and it
  resumes where it stopped").
- **New vertical:** a name plus keywords (one per line, 1–20), with a live
  estimate: 25 tiles × keywords minimum, up to 75 × keywords.
- **Pipeline:** pick a vertical, capture on this box or on Lambda, "discover →
  qualify → capture" or "discover + qualify" (`captureMode: 'none'`). **Both
  must confirm with the Places request estimate** (`estimate.floor`–`ceiling`)
  before starting. Discover is the only thing that spends money.
- **Live log:** the last 500 lines, `stream` is `out`/`err`/`sys`, a clear
  button, auto-reconnect. Keep it readable on a phone.
- Mobile-first. This panel gets checked from a phone at night.

---

## 4. The API contract (locked)

Read the route code itself; it is short and commented. This is the summary.

### 4.1 lead: `src/server/index.js`

| Route | Notes |
|---|---|
| `GET /api/verticals` | `[{ slug, label, leads, no_website, reviewed, pitch }]` |
| `GET /api/leads?vertical=&view=leads\|no-website&filter=a,b&offset=&limit=` | `{ total, rows }`. `limit` max 60. Unknown filter → 400. Order: `review_count DESC, name ASC, company_id ASC` |
| `GET /api/leads/:id` | row + `website_raw, final_url, http_status, business_status, captured_at, vertical_label, links: { social: [], other: [] }` (each link: `url, target_domain, kind, region, text`) |
| `PUT /api/leads/:id/decision` | body `{ tier: 'A'\|'B'\|'C'\|'X'\|null, pitch: boolean, note: string\|null }` → 204. 400 on bad input, 404 on unknown id |
| `GET /api/export/pitch.csv` | attachment |
| `GET /shots/:domain/:file` | `file` ∈ `desktop.webp`, `mobile.webp`; 404 if not captured. Cached a week |

Row fields: `company_id, name, domain, vertical, address, phone, rating,
review_count, primary_type, https_status ('none'|'expired'|…), cert_expires,
email, tier, pitch, note, reviewed_at`.

**Gotcha: the decision `PUT` is a full replace, not a patch.** A missing `tier`
becomes `null`, a missing `pitch` becomes `false`, a missing `note` becomes
`null`. Always send all three, merged from the current row, as
`preview/app.js` `saveDecision()` does. `reviewed_at` is set by the server; the
page never sends it. It is a UTC timestamp (see the timezone item in
`docs/STATUS.md`). Don't correct it with a hard-coded offset.

### 4.2 prospect: `src/control/index.js`

| Route | Notes |
|---|---|
| `GET /api/status` | `{ verticals: [...], total, at, unit: 'rows' }`, shape in `src/control/status.js`. 503 if the DB is down |
| `GET /api/run` | runner snapshot `{ running, state, lines, lastExit }` (`src/control/runner.js`) |
| `GET /api/events` | SSE. Events: `snapshot` (runner snapshot), `status` (as `/api/status`), `line` (`{ at, stream, line }`), `run` (`{ running, state }` or `{ running:false, lastExit }`), `verticals` (`{ added }`) |
| `POST /api/run/start` | `{ mode: 'local'\|'lambda', vertical?, concurrency?, deadline?, batch?, dryRun? }`. 409 if a run is active |
| `POST /api/run/stop` | `{ ok, message }` |
| `GET /api/verticals` | `[{ slug, label, enabled, priority, keywords, estimate: { floor, ceiling, tiles } }]`. **Different shape from lead's `/api/verticals`** |
| `POST /api/verticals` | `{ label, keywords: string[] }` → `{ ok, vertical, estimate }`. 400 with `{ error }` |
| `POST /api/pipeline/start` | `{ vertical, captureMode: 'local'\|'lambda'\|'none', concurrency?, batch? }` |

Errors are `{ error: string }` everywhere.

---

## 5. Serving and deploy: what you must change

Both servers serve fixed files today. A built app with hashed assets won't load
until you change the following. All of it is in scope.

1. **`src/server/index.js`.** The `STATIC` allow-list (top of file) and the
   `GET /` + `GET /:file` routes (`sendStatic`) only know `index.html`,
   `app.css`, `app.js`, and `/:file` is one path segment. Serve your build
   output directory instead. Requirements:
   - Nothing outside the build dir is reachable (no `..`, no absolute paths,
     no symlink escape). Unknown file → 404.
   - `/api/*` and `/shots/*` are never shadowed by static files or the SPA
     fallback.
   - Correct `Content-Type` for everything you emit (js, css, html, svg, woff2,
     png, webp, ico, json, map).
   - Hashed assets `Cache-Control: public, max-age=31536000, immutable`;
     `index.html` `no-cache`.
   - If you use history routing, fall back to `index.html` for non-API,
     non-asset GETs. Hash routing needs no fallback.
   - You may add `@fastify/static` (pinned) or keep a hand-rolled handler.
2. **`src/control/index.js`.** `GET /` reads `ui.html`. The `onRequest` auth
   hook lets through **only** `/` and `/?…`, so **every JS/CSS/font request of
   a built app would get 401** when `CONTROL_TOKEN` is set. Serve the build dir
   with the same rules as above, and exempt exactly the static asset paths
   from the hook. `/api/*` stays gated, unchanged.
3. **`scripts/test-deck.js`.** It copies `preview/{index.html,app.css,app.js}`
   into a temp root (~line 95) and asserts `/`, `/app.js`, `/../package.json`
   and `/secrets.env` (~line 300). Point it at your build output and keep the
   traversal and unknown-file assertions. Add equivalent asset/auth checks for
   control: assets load without a token, and `/api/*` still returns 401 without
   one when `CONTROL_TOKEN` is set.
4. **Where the code lives and how it builds.**
   - Put the apps outside `src/`, e.g. `web/lead/`, `web/prospect/`, and
     optionally a shared `web/ui/`. `Dockerfile.capture` copies `src/` and the
     root `package.json` into the Lambda image, and the Lambda must not grow.
   - **Never add front-end packages to the root `dependencies`.** The box runs
     `npm ci --omit=dev` from the root (`deploy/install.sh:185`) and so does
     the Lambda image. Give the web apps their own `package.json` (a workspace
     or plain subfolder) and add root scripts like `build:web`.
5. **Getting built assets onto the box.** `./p ship` does
   `git archive HEAD` (`p:423`), so the box only gets committed files, and it
   has no build toolchain (t4g.small, 2 GB). Pick one and document it in
   `docs/COMMANDS.md`:
   - (a) `./p ship` builds `web/` locally and adds the build output to the
     release tarball, failing the ship if the build fails; or
   - (b) commit the build output and add a check that fails ship if it is stale.

   Don't build on the box.
6. **`.gitattributes`: add `langfuse/ export-ignore`.** `langfuse/` is 540
   tracked files (~12 MB) and would otherwise ship to the box on every deploy.
7. **Caddy (optional).** `Caddyfile.leads` has `encode zstd gzip`,
   `Caddyfile.prospect` doesn't. Add it if you want. Leave `basic_auth` as it is.
8. **Remove the old front ends** (`git rm preview/`, `src/control/ui.html`)
   only in a commit after the new one reaches parity (§3) and tests pass. Update
   `README.md` (it lists `preview/`).
9. **Update the docs, in the commits that change behaviour:**
   `docs/ARCHITECTURE.md` (replace "Deck design", update the deck/control
   serving bullets), `docs/COMMANDS.md` (build and dev commands),
   `docs/STATUS.md`, `CLAUDE.md` ("Which doc is authoritative" still says the
   deck's design rules live in ARCHITECTURE; keep that pointer true).

---

## 6. Using `langfuse/` as the design source

`langfuse/` is a copy of the langfuse.com website source (MIT, © Langfuse GmbH).
**It cannot be built or run:** `public/` (fonts, images) and `scripts/` are not
included. Read it as a reference.

- Tokens: `langfuse/style.css` (`:root` / `.dark` custom properties, and the
  Tailwind v4 `@theme` mapping: `--surface-*`, `--text-*`, `--line-*`,
  `--radius`, the CTA yellow `--surface-cta-primary: #fbff81`) and
  `langfuse/tailwind.config.js`.
- Components: `langfuse/components/ui/` (button, badge, card, chip-card,
  corner-box, tabs, table, dialog, dropdown-menu, select, input, textarea,
  switch, tooltip, hover-card, scroll-area, pagination, number-ticker, …) and
  the page compositions in `langfuse/components/home/`.
- Fonts: the site uses Inter, Geist Mono and F37 Analog. Inter and Geist Mono
  are OFL, so self-host them from their npm packages. **F37 Analog is a
  commercial font and is not in the repo. Don't obtain or embed it**; pick an
  open substitute.
- Don't use the Langfuse logo, wordmark or name in the UI. Adopt the design
  language, not the brand. If you copy component code, keep the MIT notice in a
  header comment or a `web/THIRD_PARTY.md`.
- **Port no analytics or third-party scripts.** The source is full of PostHog,
  GTM, HubSpot, LinkedIn/Reddit/Twitter pixels, Inkeep search. None of it comes
  across. At runtime the apps make no request to any host but their own: no CDN
  fonts, no trackers.

Write a short `web/DESIGN.md`: the tokens you adopted, the component
inventory, and the keyboard map. It replaces the retired "Deck design"
contract as the reference for later changes.

---

## 7. Phases (commit throughout, push at the end of each)

0. **Preflight** (§1). Read `CLAUDE.md`, `docs/ARCHITECTURE.md` (deck and
   control sections), `docs/SCHEMA.md` (`companies`, `verticals`, `links`),
   `docs/COMMANDS.md`, both servers, `preview/app.js`, `src/control/ui.html`,
   and `git show d654788:preview/app.js`.
1. **Local environment.** MySQL 8.0, `DATABASE_URL=mysql://…/prospector_test`
   (the name **must** end in `_test`), `npm ci`, `npm run migrate`, then
   `npm run test:deck` must be green before you change anything. `data/` isn't
   in git, so to get real screenshots run `npx playwright install chromium`,
   then `npm run test:run` (5 real captures, no API key). For a larger demo set
   you may add a dev-only seed script under `scripts/` that goes through
   `scripts/test-db-helper.js` (so it refuses non-`_test` databases) and writes
   only existing columns.
2. **Scaffold** `web/` with the chosen stack, the Langfuse tokens and fonts,
   `web/DESIGN.md`, and root `build:web` / `dev:*` scripts. The dev server
   proxies `/api` and `/shots` to 7777 and `/api` to 7778.
3. **Serving and deploy** (§5, items 1–6), with tests, *before* the big UI
   work. That way every later commit is shippable.
4. **lead:** overview → vertical grid + filters + paging → no-website tab →
   detail → decisions (optimistic + revert) → CSV → keyboard (§3.2) → polish
   (loading/empty/error states, responsive, reduced motion).
5. **prospect:** token/401 state → SSE + progress → run form → new vertical +
   pipeline with spend confirmation → live log → mobile polish.
6. **Retire** `preview/` and `ui.html`, update the docs (§5, items 8–9).
7. **Verify** (§8), then fill in §9 of this file for the operator.

---

## 8. Done means

- On `langfuse`, every commit pushed to `origin/langfuse`. `main` is untouched:
  `git log origin/main -1` is the same commit as before you started.
- `npm run test:deck` green, plus your new control asset/auth checks. The web
  build passes type-check/lint if you added them.
- `npm run serve` and `npm run control` (with and without `CONTROL_TOKEN`) serve
  the **built** apps with no dev server running. Checked in a real browser at
  1440 px and 390 px wide: every item in §3.1–§3.3 works, every key in §3.2
  works, a failed `PUT` reverts with a toast (stop MySQL or the server to test
  it), and a 401 shows the token state.
- The browser devtools network tab shows zero third-party requests.
- `git archive HEAD` (or your ship path from §5.5) contains the built assets and
  not `langfuse/`.
- Accessibility basics: labelled controls, visible focus, tier as a radio group,
  `aria-pressed` on toggles, `alt` text naming the business on screenshots,
  sufficient contrast. Say plainly that full WCAG conformance needs manual
  testing with assistive technology.
- Nothing in the UI computes or implies a lead score.

---

## 9. Hand-back (fill this in at the end)

- What was built, and the stack chosen and why:
- Ship path chosen (§5.5) and how to deploy:
- What was verified, and how:
- What was not verified:
- Deviations from this handoff:

## Open requests (backend changes the design wanted, not implemented)

- *(none yet)*
