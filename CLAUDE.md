# PROSPECTOR

Deterministic lead-generation pipeline. Finds Coimbatore businesses with weak
websites, scores them, and presents a shortlist for a human operator to pitch.

Seven stages, one directory each under `src/`:
`discover → qualify → audit → extract → score → report → serve`

## Rules

**Never reimplement or retune `lib-scoring.js`.** Frozen as `rules@1`; three
modules require it. Changing `WEIGHTS` means bumping `scorer` to `rules@2` so
existing `score.json` stays attributable. Do not tune it against fixtures —
the fixtures were built to reproduce its current output, so tuning against them
is circular. Wait for real operator marks.

**`data/` here is a 5-domain smoke tree, not a real run.** `npm run test:run`
built it. The one real run (18 verticals, 3,906 leads) happened on an EC2 box and
its `data/` was never pulled down. Any measured number in `docs/STATUS.md` came
from that run and cannot be reproduced locally.

**Verify before trusting a status claim.** Check the `file:line` an item names
before working on it.

**Update `docs/STATUS.md` in the same commit as the fix.** That is the reason it
is one line per item.

**`error.json` is unreliable right now.** The score stage deletes it on success
(`src/score/index.js:140`), destroying capture-stage diagnostics. Open item.

**Captures are for human eyes only.** Nothing in `extract` or `score` reads a
`.webp` — the ranking comes from the crawl, not the screenshots.

**Get the thinnest path running before building wide.** The box deploy was
written complete, validated statically, then run — and needed 17 fixes, each
hiding the next, because `terraform validate`, `shellcheck` and `bash -n` pass on
every behavioural defect there is. One SSM write, one unit started, one Caddy
boot, executed early, would have found three whole clusters in minutes. Estimate
remaining work from what has *executed*, never from what is written.

**Never suppress an error you are about to use.** `|| true` on a predicate is
fine. `2>/dev/null` on a command whose output you then act on is a bug: it turns
a hard failure into a plausible empty string. One such line converted a Terraform
error into `""` that flowed ten minutes downstream into a fake timeout, and
another silently dropped a required field from `./p status`. If a helper returns a
value, every caller checks it — not just the careful one.

**For anything the deploy writes, say who reads it and as which uid.** Three
Caddy failures were one question unasked: the service runs as `caddy`, so a
mode-700 root-owned config directory cannot work, while `auth.env` can stay 600
because systemd reads it as root before dropping privileges.

## Verifying a change offline

No network, no API quota:

    node src/cli extract <vertical> --no-probe
    node src/cli score   <vertical>
    node src/cli report

`npm run test:run` does a real 5-domain crawl, seeded from
`scripts/smoke-seed.json` so it needs no Places key; `npm run test:clean` removes
it.

`npm run test:w1` runs the W1 acceptance tests (AC1–AC10, 40 assertions). It
needs no Places key either — discover runs `--source fixture` — but qualify does
make **real DNS and HTTP requests**, and the run leaves `data/interior-design/`
behind with no clean-up script. Delete that directory yourself afterwards.

## Which doc is authoritative

| Question | Read |
|---|---|
| Deferred specs, not yet started | `docs/PENDING-SPECS.md` |
| What's built, what's broken, what's deferred on purpose | `docs/STATUS.md` |
| How to run a stage, what flags it takes | `docs/COMMANDS.md` |
| On-disk schemas, run contract, scoring model | `spec/MASTER.md` |
| Per-stage detail and acceptance criteria | `spec/W1`–`spec/W4` |

**Code wins over spec for behaviour.** Where the two disagreed, W1's spec was
reconciled to the code, not the reverse. Spec wins for contracts: file layout,
JSON shapes, field names.

## Gotchas

- **`./p doctor` first, always.** It preflights this machine with no credentials
  and no box: binaries, DNS, path handling, CLI encoding, `.env`. `./p up` runs
  it. If you add a check it must be able to fail on a machine with no AWS access.
- **This laptop is Windows/Git Bash, not Linux — four traps, none visible in the
  code and none catchable by any linter.** Git Bash rewrites bare absolute-Unix
  paths before handing them to a native `.exe`, so `MSYS_NO_PATHCONV=1` guards
  every `/prospector/*` SSM name — and the price is that *local* paths must then
  go as `cd` plus a relative name, and `/dev/null` must be `NUL` (see
  `NULL_DEV`). There is no `getent`, so DNS goes through `resolve_a`. The aws CLI
  encodes stdout as cp1252 unless `PYTHONIOENCODING`/`PYTHONUTF8` are set, and one
  arrow in a log line is fatal. Editors here save UTF-16LE, which `_dotenv_utf8`
  and `src/cli/index.js` both work around.
- **LocalStack would not have caught most of this**, so don't reach for it: it
  emulates the AWS API, which was the smallest of the failure clusters, and its
  Community edition does not enforce IAM at all — least-privilege work passes
  green against it and fails for real.

- `npm run pipeline` (`cli all`) runs **five** stages — discover, qualify, audit,
  extract, report. `score` is excluded on purpose; run it yourself.
- Data filenames carry no underscore prefix (`qualified.json`, `leads.csv`).
  Older commit messages and spec text say `_qualified.json`.
- `GOOGLE_PLACES_KEY` is required by `discover`. `BRAVE_KEY` is optional and
  only used by the Brave fallback provider (`src/discover/brave.js`).
- `scripts/gen-fixtures.js` and `scripts/emit-sample.js` are complementary, not
  duplicates: the first writes pipeline *inputs* (`raw/`, `qualified.json`), the
  second writes expected *outputs* (`signals/links/contacts/verdict.json`, CSVs).
- `discover` is the only stage that spends Places API quota. It is deliberately
  left out of the `.claude/settings.json` allowlist so it always prompts.
- Captures are already written as `desktop.webp` / `mobile.webp` in place, so
  `npm run compress` is only useful on older PNG trees.
