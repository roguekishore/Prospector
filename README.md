# Prospector

Finds local businesses whose websites are weak enough to sell a redesign to.

Given a vertical and a city grid, it searches Google Places, probes each domain
for reachability and TLS, opens it in a real browser to capture what a customer
sees, extracts signals from the saved bytes, scores each lead with a frozen
deterministic formula, and serves a review deck where an operator marks the ones
worth pitching.

Scoring is a pure function: same input, same output, no model and no clock.

## Setup

    npm install
    cp .env.example .env     # add GOOGLE_PLACES_KEY

Playwright needs its browser once: `npx playwright install chromium`.

## Run

    npm run test:run          # real 5-domain crawl, no API key needed
    npm start                 # review deck on http://127.0.0.1:3000

A full vertical, stage by stage:

    npm run discover -- dental
    npm run qualify
    npm run audit -- dental
    npm run extract
    npm run score
    npm run report

`npm run pipeline` chains everything except `score`.

## Layout

    src/            one directory per pipeline stage
    lib-scoring.js  the scorer — frozen as rules@1, do not retune
    config/         city grid, verticals, pitch angles, reason templates
    preview/        operator review deck (static, served by src/server)
    scripts/        smoke tests, fixture generators, image compression
    spec/           frozen contracts — MASTER plus one per workstream
    docs/           STATUS (what works, what doesn't) and COMMANDS

Start with `CLAUDE.md` and `docs/STATUS.md`.

The server binds loopback only and has no authentication — it is a local
single-operator tool. Do not expose it to a network.
