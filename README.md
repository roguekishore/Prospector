# Prospector

Finds local businesses whose websites are weak enough to sell a redesign to.

Given a vertical and a city grid, it searches Google Places, probes each domain
for reachability and TLS, opens it in a real browser to capture what a customer
sees, and pulls the first email and every outside link out of the captured DOM.
The operator reads the result in the deck and decides who is worth pitching.

**Nothing in the pipeline scores, ranks or flags a lead.** There is no tier, no
formula and no model. The judgement is the operator's; this collects the
evidence.

## Setup

    npm install
    cp .env.example .env     # add GOOGLE_PLACES_KEY

Playwright needs its browser once: `npx playwright install chromium`.

MySQL holds every business and all pipeline state, so a local MySQL 8 is part of
the development setup. Point the CLI at one and create the tables:

    export DATABASE_URL=mysql://root:pw@127.0.0.1:3306/prospector
    npm run migrate -- --import-verticals path/to/verticals.json

## Run

    npm run test:run          # real 5-domain capture, no Places key needed
    npm run control           # progress dashboard + run control on :7778
    npm run serve             # the review deck on 127.0.0.1:7777

A full vertical, stage by stage:

    npm run discover -- dental
    npm run qualify -- dental
    npm run capture -- dental

`npm run pipeline -- dental` chains those three. `capture` runs extract itself,
per domain; `npm run capture -- --extract-only` exists only to re-extract what failed. When capture
runs on the Lambda instead, `npm run ingest` is what brings the results back into
MySQL and onto disk.

The tests need a scratch database whose name ends in `_test` — they truncate
tables, and the guard in `scripts/test-db-helper.js` is what stops that ever
reaching a real one:

    DATABASE_URL=mysql://root:pw@127.0.0.1:3306/prospector_test npm run test:db

## Layout

    src/            one directory per pipeline stage, plus db/ and server/
    db/migrations/  numbered plain SQL, applied by `npm run migrate`
    config/         the city grid (verticals live in MySQL)
    preview/        the deck's front end
    scripts/        smoke and acceptance tests, the Lambda dispatcher
    terraform/      persist, stack, mavdb (peering), db (the database)
    docs/           ARCHITECTURE, SCHEMA, STATUS (what works, what doesn't), COMMANDS

State is in MySQL; bytes are on disk and in S3, keyed the same way in both:

    data/<city>/companies/<domain>/  desktop.webp  mobile.webp
                                     rendered.html  extract.json  [error.json]

Start with `CLAUDE.md` and `docs/STATUS.md`.
