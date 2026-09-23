# Prospector — Command Reference

## Pipeline stages

| Command | What it does |
|---|---|
| `npm run discover -- <vertical>` | Search Google Maps for businesses in a vertical, write `_discovered.json` |
| `npm run qualify` | Probe each discovered domain — HTTP check, cert, viewport, Wayback — write `_qualified.json` |
| `npm run audit -- [vertical]` | Open each qualified domain in a real browser, capture screenshots and performance data |
| `npm run extract` | Parse raw HTML and headers into `signals.json`, `links.json`, `contacts.json` |
| `npm run score` | Run the weighted scoring formula, write `score.json` per domain *(opt-in, skipped by `pipeline`)* |
| `npm run report` | Build `data/index.json`, `_leads.csv`, `_pitch.csv`; optionally scrape agency pricing |
| `npm run pipeline` | Run discover → qualify → audit → extract → report in order |

## Dev & utilities

| Command | What it does |
|---|---|
| `npm start` | Serve the review dashboard (Fastify + static frontend) |
| `npm run test:run` | Real 5-domain smoke run into `data/interior-design-smoke/` — no Places API call |
| `npm run test:clean` | Delete `data/interior-design-smoke/` |
| `npm run compress` | Compress capture PNGs to WebP into a parallel `data-webp/` tree |
| `npm run fixtures` | Regenerate synthetic fixture data from `scripts/gen-fixtures.js` |

---

## Arguments

Args are passed after `--`: `npm run audit -- interior-design-smoke --resume`

### discover
| Arg | Default | Description |
|---|---|---|
| `<vertical>` | *(required)* | Vertical slug from `config/verticals.json` |

### qualify
| Arg | Default | Description |
|---|---|---|
| `--resume` | off | Skip domains already in `_qualified.json` |
| `--concurrency N` | 4 | Parallel probe workers |
| `--only <domain>` | — | Process one domain only |
| `--dry-run` | off | Print what would happen, touch nothing |
| `--verbose` | off | More output |

### audit
| Arg | Default | Description |
|---|---|---|
| `[vertical]` | all | Filter to one vertical slug |
| `--resume` | off | Skip domains with complete captures |
| `--concurrency N` | 4 | Parallel browser contexts |
| `--only <domain>` | — | Process one domain only |
| `--headful` | off | Open a visible browser (debugging) |
| `--timeout N` | 30000 | Navigation timeout in ms |
| `--dry-run` | off | |
| `--verbose` | off | |

### extract
| Arg | Default | Description |
|---|---|---|
| `--no-probe` | off | Skip dead-link HEAD requests (offline / faster) |
| `--resume` | off | Skip domains with existing output |
| `--only <domain>` | — | |
| `--dry-run` | off | |
| `--verbose` | off | |

### score
| Arg | Default | Description |
|---|---|---|
| `--ref-year N` | 2026 | Year used for staleness calculation |
| `--resume` | off | Skip domains with existing `score.json` |
| `--only <domain>` | — | |
| `--dry-run` | off | |
| `--verbose` | off | |

### report
| Arg | Default | Description |
|---|---|---|
| `--no-agency-fetch` | off | Skip agency pricing/portfolio scraping (offline / faster) |
| `--dry-run` | off | |
| `--verbose` | off | |

### serve
| Arg | Default | Description |
|---|---|---|
| `--port N` | 3000 | Port to listen on |

### compress
| Arg | Default | Description |
|---|---|---|
| `--src <dir>` | `data` | Source directory containing PNGs |
| `--out <dir>` | `data-webp` | Output directory for WebP files |
| `--swap` | off | Replace originals with compressed versions |
