# PROSPECTOR

Lead-generation pipeline. Finds Coimbatore businesses, captures what their
websites look like, and presents the evidence for a human operator to judge.

`discover → qualify → capture`, one directory each under `src/`. Capture runs
extract per domain, in the same worker slot; `extract` is also a standalone
stage, for re-extracting what failed. `migrate`, `ingest`, `control` and `serve`
are commands, not stages.

**MySQL is the state store.** Every business and every piece of pipeline state
is a row in `companies` (`docs/SCHEMA.md`); S3 and `data/` hold bytes and nothing
else. `src/db/mysql.js` is the only module that opens a connection.

## Rules

**No scoring, ever.** Nothing computes a tier, score, pitch angle, flag or
signal. `lib-scoring.js`, `src/score/`, `src/report/` and
`src/extract/signals/` are deleted, not disabled, and nothing replaces them.
The operator reads the shots, the first email and the outside links, and
decides. If a request starts with "rank" or "which are the best leads", the
answer is a query over `docs/SCHEMA.md`, not a formula.

**One row per `place_id`, and rows can share a website.** That is the only
identity rule. Discover never merges listings that share a domain — two showrooms
on one website are two businesses to call. Capture, extract and ingest run once
per distinct `(city, domain)` and write the result to every row with that domain,
so `SELECT DISTINCT domain` is how work lists are built and the control panel's
counts are **rows**, not domains.

**Nothing but `src/db/mysql.js` opens a connection, and every stage closes the
pool.** A stage that returns without `close()` leaves the process hanging after
its last log line, which looks exactly like a stage still working. `tx()` runs at
READ COMMITTED on purpose — see the comment there before changing it.

**`data/` here is a 5-domain smoke tree, not a real run.** `npm run test:run`
built it. The one real run (18 verticals, 3,906 leads) happened on an EC2 box and
its `data/` was never pulled down. Any measured number in `docs/STATUS.md` came
from that run and cannot be reproduced locally.

**Verify before trusting a status claim.** Check the `file:line` an item names
before working on it.

**Update `docs/STATUS.md` in the same commit as the fix.** That is the reason it
is one line per item.

**`error.json` is written only by capture, and never deleted.** A domain that
failed, was retried and succeeded keeps it, so a stale one proves nothing on its
own: `isComplete()` is the authority on whether a capture is done.

**Captures are for human eyes only.** Nothing reads a `.webp`. `extract` reads
`rendered.html` and nothing else.

**A domain is captured once, whatever its vertical.** One folder,
`data/<city>/companies/<domain>/`, built by `companyDir` in `lib-keys.js` and
mirrored by `companyKey` in `src/capture/s3.js`. Three places dedupe by
canonical domain — the capture queue, `scripts/dispatch.js` and
`src/control/status.js`. Miss one and a domain is captured twice.

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

Everything but `test:extract` needs a local MySQL and a `DATABASE_URL` whose
database name ends in `_test`. `scripts/test-db-helper.js` refuses anything
else — these suites truncate tables, and that guard is what stands between a
copied shell line and the real run.

    export DATABASE_URL=mysql://root:pw@127.0.0.1:3306/prospector_test

No network, no API quota, no browser:

    npm run test:extract      # 38 assertions, no database either
    npm run test:db           # 99 — migrate, discover, qualify, record, ingest
    npm run test:deck         # 77 — the deck's routes through Fastify inject

`npm run test:lambda` drives the Lambda's whole batch flow against a stub S3
client — no AWS account, but it does take two real captures.

`npm run test:run` does a real 5-domain capture, seeded into `companies` from
`scripts/smoke-companies.json` so it needs no Places key; it asserts on the
folder **and** on the rows. `npm run test:clean` removes both.

`npm run test:w1` runs the W1 acceptance tests (AC1–AC10, 41 assertions). It
needs no Places key either — discover runs `--source fixture` — but qualify does
make **real DNS and HTTP requests**. It empties the test tables in a `finally`.

## Which doc is authoritative

| Question | Read |
|---|---|
| How it's built, where it runs, and why | `docs/ARCHITECTURE.md` |
| Spec order (A–E, in `.kiro/specs/`) and files still to remove | `docs/PENDING-SPECS.md` |
| MySQL tables, statuses, who writes which column | `docs/SCHEMA.md` |
| What's built, what's broken, what's deferred on purpose | `docs/STATUS.md` |
| How to run a stage, what flags it takes | `docs/COMMANDS.md` |
| On-disk schemas and the run contract | `spec/MASTER.md` |
| The MySQL tables `extract.json` feeds | `docs/SCHEMA.md` |
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

- **`./p db` needs `session-manager-plugin`,** and nothing else does. mavdb is
  private and this laptop is in neither VPC, so that command tunnels
  `127.0.0.1:13306` through the box over SSM. `./p doctor` warns rather than
  fails when it is missing, because a laptop that will never apply the database
  root is not broken for lacking it.
- **`DATABASE_URL` must never reach SSM.** `load-env.sh` turns every parameter
  under `/prospector/` into an environment variable, so one there would silently
  replace the box's verified-TLS connection with whatever it pointed at.
  `./p secrets` copies named keys only; keep it that way.
- `npm run pipeline` (`cli all`) runs **three** stages — discover, qualify,
  capture — and capture includes extract. `ingest` is deliberately not one of
  them: a local capture records itself, and ingest exists for the Lambda path.
- `GOOGLE_PLACES_KEY` is required by `discover`. `BRAVE_KEY` is optional and
  only used by the Brave fallback provider (`src/discover/brave.js`).
- `discover` is the only stage that spends Places API quota. It is deliberately
  left out of the `.claude/settings.json` allowlist so it always prompts. Its
  keywords come from the `verticals` table, not from a file.
- **The peering and the database are written but not applied.** `terraform/mavdb`
  and `terraform/db` have never run; so has nothing that needs mavdb. Anything
  measured against MySQL so far was measured against a local MySQL 8.0.39.
- Older commit messages and spec text mention `discovered.json`,
  `qualified.json` and `_qualified.json`. Those files do not exist; the rows
  replaced them.
