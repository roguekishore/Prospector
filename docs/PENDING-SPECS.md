# Pending specs

The order of remaining work, the decisions every spec shares, and the files
still to delete. The work itself lives in `.kiro/specs/<spec>/`
(`requirements.md`, `design.md`, `tasks.md`); this file only indexes it.

## Standing decisions (operator, 2026-09-26, final)

- **No scoring, ever.** No machine score, tier, flag, signal or pitch angle. The
  deck shows Places details, screenshots, what extract found, and the
  operator's own decisions.
- **Pipeline:** `discover → qualify → capture`, and capture runs extract per
  domain (`src/capture/extract/`; re-runs are `capture --extract-only`).
  `ingest`, `migrate`, `serve` and `control` are commands, not stages.
- **Capture keeps** `desktop.webp`, `mobile.webp`, `rendered.html`; **extract
  writes** `extract.json` (first email, outside links). Extract makes no network
  request. No agency detection; the operator derives agencies from links.
- **One layout,** `<city>/companies/<domain>/`, flat, on disk and in S3. A domain
  is captured once, never re-captured; bucket versioning is suspended.
- **MySQL is the source of truth** for businesses and pipeline state
  (`docs/SCHEMA.md`). `place_id` is the only identity rule; the first write of a
  place ID wins. Capture and extract run once per distinct domain.
- **Backups of MySQL are the operator's**, not a spec's.
- **Credentials:** the operator supplies root keys for rogue (and clasher) at run
  time. No spec builds an admin role.

## Order

| Spec | Folder | State |
|---|---|---|
| A — capture and extract | `spec-a-capture-extract` | **Done.** `terraform plan` and the image build still need the operator (spec C task 1) |
| B — MySQL and the deck | `spec-b-mysql-deck` | **Code done and tested offline.** Nothing applied: `./p peer`, `./p db`, `terraform apply persist`/`stack` and `./p up` all need the operator — see `docs/STATUS.md` |
| C — running capture | `spec-c-running-capture` | After B. First real Lambda batch, failure queue, budget guard, the sweep |
| D — warden capture tile | `spec-d-warden-capture-tile` | After C's first batch (repo `AWS-COMMAND-CENTER`) |
| E — mavdb security | `spec-e-mavdb-security` | Independent; any time (repo `MAVDB`, proposed) |

`box-discover-qualify` is done bar three operator-only checks, tracked in its
own `tasks.md`.

## Files removed for good

A file leaves the repo in the same commit as the step that makes it dead, never
earlier.

| File | Removed by | Blocker |
|---|---|---|
| `src/score/`, `lib-scoring.js`, `src/report/`, `src/extract/signals/`, `src/extract/contacts.js` | Done, spec A | — |
| `config/{angles,reasons,themeforest-slugs,agency-aliases}.json` | Done, spec A | — |
| `scripts/{emit-sample,gen-fixtures,compress-shots}.js`, `ops/run-night.sh` | Done, spec A | — |
| `docs/DEPLOYMENT.md` | Merged into `docs/ARCHITECTURE.md` (`## The box`) | — |
| `src/db/index.js`, `better-sqlite3`, `index.db*` in `.gitignore`, `preview/data.js`, `preview/mocks.js` | Done, spec B (`src/server/` and `preview/app.js` rewritten, not deleted) | — |
| `scripts/backup-places.js`, `deploy/prospector-backup.{service,timer}`, `config/verticals.json`, `scripts/smoke-seed.json` | Done, spec B | The box's persistent `verticals.json` is still there and is what `migrate --import-verticals` reads; `install.sh` removes the two backup units on its next run |
| `logs/*.log`, `ops/recover.sh` | Spec C | Operator's go; their figures are already in `docs/STATUS.md` |

No longer produced, and left wherever they sit (nothing reads them):
`score.json`, `verdict.json`, `signals.json`, `links.json`, `contacts.json`,
`headers.json`, `home.html`, `data-webp/`, and the S3 prefixes `captures/`,
`derived/`, `places-raw/` and `places/` (nothing has written the last of those
since spec B; the box role no longer even has permission to).

Delete this file once spec C is done; by then the table above is empty or
historical.
