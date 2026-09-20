# Orchestrator brief — PROSPECTOR build

You are the orchestrator for a four-workstream parallel build. You do **not**
write application code yourself. You do pre-flight, spawn four sub-agents, then
integrate and verify what they return.

Working directory: `D:\PROJECTS\PROSPECTOR`

## What is being built

A deterministic lead-generation pipeline. It finds Coimbatore businesses that
already pay for a website, whose current site is dated or broken enough that a
redesign is an easy sell, and presents them to a single human operator for
review. Six stages: `discover → qualify → audit → extract → score → report`.

**There are zero LLM calls anywhere in this system.** Every judgement is a pure
function of bytes saved to disk. `MASTER.md §1.3` explains what each formerly-LLM
job became. If a sub-agent proposes adding a model call, reject it.

## Read before anything else

`spec/MASTER.md` — the whole system, all frozen file contracts, the scoring
model, the design contract, the glossary. Then the four workstream specs:

```
spec/W1-discovery.md      discover + qualify
spec/W2-capture.md        audit (Playwright captures)
spec/W3-extract-score.md  extract + score + report + cli + db + server
spec/W4-frontend.md       preview/ — what the operator looks at
```

These specs are **frozen contracts, not proposals**. Every JSON shape, every
threshold, every keybinding is already decided. A sub-agent's job is to
implement its spec, not to improve it. If a spec is genuinely self-contradictory,
the sub-agent reports the contradiction to you and stops; it does not pick a
side. Do not let an agent redesign a contract that another agent is
simultaneously coding against.

## Step 0 — pre-flight, before you spawn anything

1. **Create `package.json`.** It does not exist, and W1/W2/W3 all need
   dependencies. If three agents each create it in parallel they clobber each
   other, so you create it once, now, and no sub-agent ever writes it.

   Resolve each exact version with `npm view <pkg> version` and pin it with no
   `^` and no `~` (`MASTER.md §2`). Needed: `tldts` (W1 — registrable domain
   parsing), `playwright` (W2 — chromium headless-shell), `better-sqlite3`
   (W3 — the `index.db` schema in `MASTER.md §12`). W4 needs nothing; it is
   plain HTML/CSS/JS with no build step.

   Set `"type": "commonjs"` — `lib-scoring.js` and `emit-sample.js` already use
   `require`.

2. **Verify the fixture tree is intact** before and after the build:

   ```
   node emit-sample.js        # must print: wrote 18 lead folders + 3 run files
   ```

   93 files under `data/`. These 18 synthetic lead folders are the frozen
   contract that lets all four workstreams start at minute one instead of
   waiting in sequence. **Nothing may delete or overwrite them.** If an agent
   needs to write real run output, it uses a different vertical slug.

3. Confirm `config/` holds six files and each parses: `city.json`,
   `verticals.json`, `angles.json`, `reasons.json`, `agency-aliases.json`,
   `themeforest-slugs.json`. These are **written and frozen**. `W1-discovery.md`
   lists `verticals.json` and `city.json` under "Owns" — that means W1 reads
   them as authoritative input, not that W1 regenerates them.

4. Do **not** install Playwright browsers yourself. `npx playwright install
   chromium --with-deps` is a large download; surface it to the human and let
   them approve it. W2 can be written and unit-tested without it.

## Pre-resolved collisions — state these to the sub-agents verbatim

These are the only three places where the workstreams touch the same file.
They are decided. No agent negotiates them.

**1. `package.json` — nobody writes it.** You created it in step 0. An agent
needing a dependency you missed reports that to you; you add it.

**2. `src/cli/` belongs to W3 alone.** W1 and W2 both document CLI subcommands
(`node src/cli discover`, `node src/cli audit`) but must not write the
dispatcher. The frozen interface, which all three implement against without
talking to each other:

```js
// every stage module, at its own directory's index.js
module.exports = { run: async (argv, ctx) => {} };
//   src/discover/index.js   src/qualify/index.js     ← W1
//   src/capture/index.js                             ← W2
//   src/extract/index.js    src/score/index.js       ← W3
//   src/report/index.js
// ctx = { root, config, log }   — W3 defines and passes it
```

W3 writes `src/cli/index.js` to require those paths and dispatch by subcommand
name. A stage whose module does not exist yet must fail with a clear message,
never crash the dispatcher — the stages land at different times.

**3. `preview/app.css` is the design contract, copied forward byte-for-byte.**
W4 extends it in the same idiom and never rewrites it. No other agent touches
`preview/`.

## The four sub-agents

Spawn all four at once. Each gets its own spec and nothing else. Give each this
prompt, substituting the spec filename and the ownership line:

> You are implementing one workstream of the PROSPECTOR build in
> `D:\PROJECTS\PROSPECTOR`. Read `spec/MASTER.md` in full, then read
> `spec/<YOUR-SPEC>.md` in full, then implement it.
>
> That spec is a frozen contract. Every file shape, threshold, and interface in
> it is already decided — implement it exactly, do not redesign it. If you find
> a genuine self-contradiction, report it and stop rather than choosing a side:
> three other agents are coding against the same contracts right now.
>
> You own exactly the paths listed under **Owns** in your spec's header. Do not
> create, edit, or delete a file outside them. In particular: do not write
> `package.json` (already done), do not touch `lib-scoring.js` (frozen as
> `rules@1`), do not touch `preview/app.css` unless you are W4, and do not
> delete or overwrite anything under `data/` — those 18 lead folders are the
> fixture contract every workstream depends on.
>
> There are no LLM calls in this system. Every judgement is a pure function of
> saved bytes. Do not add a model call, an API key, or a network dependency the
> spec does not name.
>
> Your spec ends with numbered acceptance criteria. Before you report done, run
> each one and state its result. Do not claim a criterion passes without having
> executed it — if you could not run something, say which and why.
>
> Report back: files created, each acceptance criterion with its actual result,
> anything you could not verify, and any assumption you had to make.

Ownership lines to paste into each, so no agent has to infer its boundary:

```
W1  src/discover/  src/qualify/              reads config/, writes data/<v>/_*.json
W2  src/capture/                             reads _qualified.json, writes PNGs + raw/
W3  src/extract/ src/score/ src/report/      reads raw/, writes signals/links/contacts/
    src/cli/ src/db/                         score.json + index.json + index.db
W4  preview/index.html app.js mocks.js       reads data/index.json + PNGs
```

## Global do-not, applying to every agent

- No LLM call, no API key beyond `GOOGLE_PLACES_KEY` in `.env` (W1 only), no
  telemetry, no CDN or external font request.
- No colour anywhere in the interface. Black, white, and opacity steps of white
  only. Tier is a glyph (`■ A · ▣ B · □ C · · X`), never a hue.
- No React, Vue, Svelte, Tailwind, or bundler in `preview/`.
- Never log, print, or write the Places key — not to stdout, not into
  `_discovered.json`, not into an error message.
- The review server binds `127.0.0.1` only, never `0.0.0.0`.
- robots.txt is honoured in every stage that makes a request.
- The frontend never computes a tier, score, or angle. It renders judgements and
  records the operator's; it never makes one.

## After all four return

1. Re-run `node emit-sample.js` and confirm 93 files and the 15/18 tier
   agreement still hold. Drift here means someone edited a frozen contract.
2. Run the pipeline end to end against `--source fixture`, which needs no
   credential: `discover → qualify → audit → extract → score → report`.
3. Start `node src/cli serve` and confirm the frontend loads from real
   `index.json`, that the synthetic banner appears when `synthetic: true`, and
   that every keybinding in `W4 §5` has a visible clickable equivalent.
4. Grep the CSS for any hex value other than `#fff`/`#000` and any `rgba` that
   is not `rgba(255,255,255,*)`. A hit is a defect.
5. Check the `MASTER.md §15` definition of done.

Report to the human: what each workstream delivered, which acceptance criteria
actually passed versus went unverified, and what remains. Do not report a build
as complete on the strength of an agent's own claim that it works — the
verification above is yours to run.
