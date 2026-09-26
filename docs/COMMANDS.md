# Prospector — Command Reference

## Pipeline stages

| Command | What it does |
|---|---|
| `npm run discover -- <vertical>` | Search Google Places for businesses in a vertical, write `discovered.json` |
| `npm run qualify -- [vertical]` | Probe each discovered domain — HTTP, cert, Wayback — write `qualified.json` |
| `npm run capture -- [vertical]` | Open each qualified domain in a real browser, write the shots and `rendered.html`, then extract |
| `npm run extract -- [vertical]` | Re-run extract over captures already on disk. Not part of a normal run |
| `npm run control` | Progress dashboard + run control on :7778. Set `CONTROL_TOKEN` for network access |
| `npm run pipeline -- <vertical>` | discover → qualify → capture, in order |
| `npm run dispatch -- [vertical]` | Send capture batches to the Lambda instead of running them here |

`capture` runs extract per domain, in the same worker slot, as soon as the
capture completes. The standalone `extract` stage exists for one situation: an
extract bug is fixed and the captures are already paid for.

There is no `audit`, `score`, `report` or `serve` stage. Nothing computes a
score, a tier or a pitch angle.

## Dev & utilities

| Command | What it does |
|---|---|
| `npm run test:run` | Real 5-domain capture from `scripts/smoke-seed.json` — no Places key |
| `npm run test:clean` | Delete everything `test:run` wrote |
| `npm run test:extract` | Extract acceptance tests. Offline: no browser, no network |
| `npm run test:lambda` | Drive the Lambda's batch flow over two domains with a stub S3 client |
| `npm run test:w1` | W1 acceptance tests (discover + qualify). Makes real DNS and HTTP requests |

---

## Arguments

Args are passed after `--`: `npm run capture -- interior-design-smoke --resume`

### discover
| Arg | Default | Description |
|---|---|---|
| `<vertical>` | *(required)* | Vertical slug from `config/verticals.json` |
| `--source <name>` | `places-new` | `places-new`, `brave` or `fixture` |
| `--limit N` | — | Stop after N results |
| `--dry-run` | off | Print what would happen, touch nothing |

### qualify
| Arg | Default | Description |
|---|---|---|
| `[vertical]` | all | Filter to one vertical slug |
| `--resume` | off | Skip domains already in `qualified.json` |
| `--concurrency N` | 4 | Parallel probe workers |
| `--only <domain>` | — | Process one domain only |
| `--dry-run` | off | Print what would happen, touch nothing |
| `--verbose` | off | More output |

### capture
| Arg | Default | Description |
|---|---|---|
| `[vertical]` | all | Filter to one vertical slug |
| `--resume` | off | Skip a domain whose capture **and** `extract.json` are both present; extract only when the capture alone is |
| `--concurrency N` | 4 | Parallel browser contexts |
| `--only <domain>` | — | Process one domain only |
| `--headful` | off | Open a visible browser (debugging) |
| `--timeout N` | 30000 | Navigation timeout in ms |
| `--deadline N` | 60000 | Hard ceiling on one whole capture |

### extract
| Arg | Default | Description |
|---|---|---|
| `[vertical]` | all | Filter to one vertical slug |
| `--resume` | off | Skip domains that already have `extract.json` |
| `--only <domain>` | — | Process one domain only |
| `--dry-run` | off | Print what would happen, touch nothing |

### dispatch
| Arg | Default | Description |
|---|---|---|
| `[vertical]` | all | Filter to one vertical slug |
| `--batch N` | 10 | Domains per Lambda invoke. 10 × 60s deadline fits the 900s ceiling; 15 does not |
| `--dry-run` | off | Print the plan, invoke nothing |
| `--function <name>` | `prospector-capture` | Lambda function name |
| `--region <name>` | `ap-south-1` | |

---

## Notes

`capture --timeout` bounds **navigation only**. `--deadline` is the ceiling on
the whole capture — settle sequence, image decode and both screenshots — and is
what makes a Lambda batch's worst case finite.

A domain listed in two verticals is captured once. The output folder is keyed by
domain alone, so `capture`, `dispatch` and the control panel's status all dedupe
by canonical domain.

Extract makes no network request. There is no dead-link probe.
