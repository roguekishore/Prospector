# Prospector

Finds local businesses whose websites are weak enough to sell a redesign to.

Given a vertical and a city grid, it searches Google Places, probes each domain
for reachability and TLS, opens it in a real browser to capture what a customer
sees, and pulls the first email and every outside link out of the captured DOM.
The operator reads the result and decides who is worth pitching.

**Nothing in the pipeline scores, ranks or flags a lead.** There is no tier, no
formula and no model. The judgement is the operator's; this collects the
evidence.

## Setup

    npm install
    cp .env.example .env     # add GOOGLE_PLACES_KEY

Playwright needs its browser once: `npx playwright install chromium`.

## Run

    npm run test:run          # real 5-domain crawl, no API key needed
    npm run control           # progress dashboard + run control on :7778

A full vertical, stage by stage:

    npm run discover -- dental
    npm run qualify -- dental
    npm run capture -- dental

`npm run pipeline -- dental` chains those three. `capture` runs extract itself,
per domain; `npm run extract` exists only to re-run extract over captures that
are already on disk.

## Layout

    src/            one directory per pipeline stage
    config/         city grid and verticals
    scripts/        smoke and acceptance tests, the Lambda dispatcher
    terraform/      the box, the capture Lambda, the buckets
    spec/           frozen contracts — MASTER plus one per workstream
    docs/           STATUS (what works, what doesn't), COMMANDS, SCHEMA

Output lands in two places, both keyed the same way:

    data/<vertical>/discovered.json  qualified.json
    data/<city>/companies/<domain>/  desktop.webp  mobile.webp
                                     rendered.html  extract.json  [error.json]

`src/server/`, `src/db/` and `preview/` are the old review deck. They are
retired, not deleted, and nothing loads them — spec B rebuilds the deck on
MySQL.

Start with `CLAUDE.md` and `docs/STATUS.md`.
