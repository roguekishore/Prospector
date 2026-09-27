# Prospector — Command Reference

Every stage reads and writes MySQL. `DATABASE_URL` points it at one; on the box
`DB_HOST` and `DB_PASSWORD` come out of SSM instead (see **The database** below).

## Pipeline stages

| Command | What it does |
|---|---|
| `npm run migrate` | Apply `db/migrations/` in order. Re-running is a no-op |
| `npm run discover -- <vertical>` | Search Google Places for businesses in a vertical, insert one `companies` row per place ID |
| `npm run qualify -- [vertical]` | Probe each distinct domain — HTTP, TLS, parked page — and write the verdict onto every row with that domain |
| `npm run capture -- [vertical]` | Open each pending domain in a real browser, write the shots and `rendered.html`, extract, and record the result |
| `npm run capture -- --extract-only [vertical]` | No browser: re-extract the domains whose extract failed. Not part of a normal run |
| `npm run ingest -- [vertical]` | Pull the Lambda's captures out of S3, onto disk, and into MySQL |
| `npm run control` | Progress dashboard + run control on :7778. Set `CONTROL_TOKEN` for network access |
| `npm run serve` | The review deck on 127.0.0.1:7777 (`npm start` is the same thing) |
| `npm run pipeline -- <vertical>` | discover → qualify → capture, in order |
| `npm run dispatch -- [vertical]` | Send capture batches to the Lambda instead of running them here |

`capture` runs extract per domain, in the same worker slot, as soon as the
capture completes. `capture --extract-only` exists for one situation: an extract
bug is fixed and the captures are already paid for.

`ingest` is deliberately **not** part of `pipeline`. A local capture records
itself; ingest is for the Lambda path, where the bytes land in S3 and nothing
would otherwise tell the database they exist. A systemd timer runs it every 15
minutes on the box.

There is no `audit`, `score` or `report` stage. Nothing computes a score, a tier
or a pitch angle — the deck shows the evidence and stores the operator's answer.

## Dev & utilities

All of these need `DATABASE_URL` pointing at a scratch database whose name ends
in `_test`; `scripts/test-db-helper.js` refuses anything else, because they
truncate tables between files.

```
DATABASE_URL=mysql://root:pw@127.0.0.1:3306/prospector_test npm run test:db
```

| Command | Network? | What it does |
|---|---|---|
| `npm run test:db` | no | migrate, discover, qualify, `recordDomain` and ingest against MySQL and a stub S3 |
| `npm run test:deck` | no | The deck's routes through Fastify `inject` — paging, filters, decisions, CSV, screenshots |
| `npm run test:extract` | no | Extract acceptance tests |
| `npm run test:lambda` | two real captures | Drives the Lambda's batch flow over two domains with a stub S3 client |
| `npm run test:w1` | real DNS + HTTP | Discover + qualify acceptance tests. Discover runs `--source fixture`; qualify really probes |
| `npm run test:run` | five real captures | Seeds `companies` from `scripts/smoke-companies.json` and captures them. No Places key |
| `npm run test:clean` | no | Deletes the folders `test:run` wrote and empties the test tables |

## The web UIs: `web/`

The two browser UIs — **lead** (the review deck) and **prospect** (the control
panel) — are Vite + React apps under `web/`, with their own `package.json` so
nothing front-end lands in the root `dependencies` (the box and the Lambda run
`npm ci --omit=dev` from the root). `web/DESIGN.md` is the design contract.

| Command | What it does |
|---|---|
| `npm run web:ci` | `npm ci` inside `web/` — once per clone, and after `web/package-lock.json` changes |
| `npm run build:web` | Type-check, then build both apps into `web/dist/lead/` and `web/dist/prospect/` |
| `npm run dev:lead` | Vite dev server for the deck on `127.0.0.1:5177`, proxying `/api` and `/shots` to `:7777` — run `npm run serve` alongside |
| `npm run dev:prospect` | Vite dev server for the control panel on `127.0.0.1:5178`, proxying `/api` to `:7778` — run `npm run control` alongside |

`npm run serve` and `npm run control` serve `web/dist/<app>/` as built, so a
change to the UI needs `npm run build:web` before it shows there. `web/dist/`
is not committed; see **`./p ship`** below for how it reaches the box.

---

## Arguments

Args are passed after `--`: `npm run capture -- interior-design-smoke --concurrency 2`

### migrate
| Arg | Default | Description |
|---|---|---|
| `--import-verticals <file>` | — | Load a JSON array of verticals into the table. Existing slugs are left alone |

### discover
| Arg | Default | Description |
|---|---|---|
| `<vertical>` | *(required)* | Slug of an enabled row in `verticals` |
| `--source <name>` | `places-new` | `places-new`, `brave` or `fixture` |
| `--dry-run` | off | Print the request list, spend nothing |

### qualify
| Arg | Default | Description |
|---|---|---|
| `[vertical]` | all | Filter to one vertical slug |
| `--concurrency N` | 8 | Parallel probe workers |

There is no `--resume`: the work list is every row still at `status IS NULL`, so
running qualify again probes exactly what is left.

### capture
| Arg | Default | Description |
|---|---|---|
| `[vertical]` | all | Filter to one vertical slug |
| `--retry-failed` | off | Include domains at `status = -2` as well as `0` |
| `--concurrency N` | 4 | Parallel browser contexts |
| `--only <domain>` | — | Process one domain only |
| `--headful` | off | Open a visible browser (debugging) |
| `--timeout N` | 30000 | Navigation timeout in ms |
| `--deadline N` | 60000 | Hard ceiling on one whole capture |

`--resume` is implied — the work list is `status = 0` — and is accepted with a
warning for one release, because an older control panel still passes it.

### extract
| Arg | Default | Description |
|---|---|---|
| `[vertical]` | all | Filter to one vertical slug |
| `--only <domain>` | — | Process one domain only |
| `--dry-run` | off | Print what would happen, touch nothing |

Its work list is `status = 1 AND extract_status = -2`. When `rendered.html` is
not on this machine it is downloaded from `CAPTURE_BUCKET` first, and the new
`extract.json` is uploaded back.

### ingest
| Arg | Default | Description |
|---|---|---|
| `[vertical]` | all | Filter to one vertical slug |
| `--with-html` | off | Also download `rendered.html`. Off by default: nothing local reads it, and it is by far the largest file |

### dispatch
| Arg | Default | Description |
|---|---|---|
| `[vertical]` | all | Filter to one vertical slug |
| `--batch N` | 10 | Domains per Lambda invoke. 10 × 60s deadline fits the 900s ceiling; 15 does not |
| `--retry-failed` | off | Include domains at `status = -2` |
| `--dry-run` | off | Print the plan, invoke nothing. Needs the database but no AWS credentials |
| `--function <name>` | `prospector-capture` | Lambda function name |
| `--region <name>` | `ap-south-1` | |

### serve
| Arg | Default | Description |
|---|---|---|
| `--port N` | 7777 | The bind address is always 127.0.0.1; Caddy is the only public listener |

---

## The box: `./p`

| Command | What it does |
|---|---|
| `./p doctor` | Preflight this machine: binaries, DNS, path handling, CLI encoding, `.env`. No credentials needed |
| `./p up` | doctor, `terraform apply` persist + stack, secrets, ship, migrate, enable Caddy |
| `./p ship` | `git archive HEAD` → S3, `install.sh` on the box, update the function |
| `./p secrets` | Copy the named keys out of `.env` into SSM SecureString |
| `./p status` | SSM ping, both services, DNS vs EIP, both 401s, image tag, DLQ depth, MySQL row counts |
| `./p logs` | Tail the control service's journal |
| `./p down` | Destroy `stack.tfstate` — the box and the Lambda, nothing else |
| `./p peer` | Apply `terraform/mavdb`: the VPC peering to clasher |
| `./p db` | Apply `terraform/db`: the database, user, grants and SSM parameters |

`up` and `down` never touch `peer` or `db`. `down` destroys the box; the network,
the peering and the database all survive it, which is why the box reconnects to
mavdb on the next `up` with no further work.

`peer` and `db` each show you the plan and wait for you to type `yes`.

### `./p db` needs the Session Manager plugin

mavdb is not publicly accessible and the laptop is in neither VPC, so `./p db`
tunnels through the box:

```
laptop :13306  --SSM-->  the box  --peering-->  mavdb :3306
```

That needs `session-manager-plugin` on `PATH` — `./p doctor` warns when it is
missing. Install it from
<https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html>.

### Order, from nothing

```
./p up        # the box, the network, the services
./p peer      # the peering to mavdb          (clasher root CSV)
./p db        # the database, user and grants (MAVERICK_DB_PASSWORD in .env)
./p up        # again: migrate now has something to migrate
```

---

## The database

`src/db/mysql.js` is the only module that opens a connection, and it takes its
configuration from exactly two places:

- **`DATABASE_URL`**, when set. The laptop and every test. Plain TCP, no TLS
  verification — a local MySQL has no certificate worth checking.
- **`DB_HOST` and `DB_PASSWORD`** otherwise. On the box these come from
  `/run/prospector/env`, which `load-env.sh` writes from SSM. TLS is verified
  against `/opt/prospector/rds-global-bundle.pem`, host name included.

`DATABASE_URL` must never reach SSM. `./p secrets` copies named keys only, and
`load-env.sh` turns every parameter under `/prospector/` into an environment
variable — so a `DATABASE_URL` in there would silently replace the box's
verified connection with whatever it pointed at.

---

## Notes

`capture --timeout` bounds **navigation only**. `--deadline` is the ceiling on
the whole capture — settle sequence, image decode and both screenshots — and is
what makes a Lambda batch's worst case finite.

A domain is captured once, whatever its vertical. Several `companies` rows can
share one website: `capture` (with or without `--extract-only`), `dispatch` and `ingest` all work from
`SELECT DISTINCT domain`, and the result is written to every row with that
domain. The control panel's counts are **rows**, not domains.

Extract makes no network request. There is no dead-link probe.
