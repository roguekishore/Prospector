# Status

All seven stages are built and the pipeline has completed one real run
(18 verticals, 3,906 scored leads, on an EC2 box). That run is what produced the
open list below — the pipeline works end to end, and running it at scale exposed
these. Figures come from that run and cannot be reproduced against local `data/`.

Update this file in the same commit as the fix.

## Open — offline, no re-crawl, no API quota

Verify each with `extract --no-probe` → `score` → `report` (see `CLAUDE.md`).

- [ ] **Phone regex drops 11.5% of valid Indian mobiles.** The year clause is
      unanchored and runs against the normalised digit string, so any number
      containing `19xx`/`20xx` is discarded (`9820123456` → dropped). Two other
      clauses are dead — `normalisePhone` strips non-digits before the test.
      Keep `^\d{6}$`, delete the rest. — `src/extract/contacts.js:30`
- [ ] **953 leads display no phone though Places supplied one.** Address already
      falls back to the Places entry, phone does not; the same `qualified` object
      is already in scope. A Places phone is the business's own, so it must be
      exempt from the cross-site frequency rule that reassigns contacts to
      agencies. — `src/extract/contacts.js:162`
- [ ] **No WhatsApp extraction exists at all.** The signal detector finds
      WhatsApp on 77 of 139 dental pages; `contacts.js` has no `wa.me` handling,
      so 0 leads carry it. It is how Indian local businesses actually get
      contacted. — `src/extract/contacts.js`
- [ ] **Agency attribution never compounds.** Every agency name appears exactly
      once, so cross-site frequency inversion cannot work. Copyright fragments
      parse as company names (`"Vivdleo.com , All rights reserved"`) and one
      domain emitted a doubled TLD (`krishnadentalclinic.com.com`).
      — `src/report/agency.js`
- [ ] **Hosting platforms reach scoring as businesses.** `vercel.app`,
      `ueniweb.com`, `bolt.host`, `mypixieset.com`, `sleek.fitness` are absent
      from both `REJECT_DOMAINS` and `GREENFIELD_DOMAINS`; many businesses
      collapse onto one registrable domain and then fail at score time with
      `review_count is undefined`. — `src/discover/index.js:21`

## Open — needs a re-crawl

- [ ] **Re-run `discover` on the fixed field mask.** During run 1 the box lacked
      the `nextPageToken` field-mask fix, so every tile×keyword returned page 1
      only, capped at 20 results. **3,906 is a floor, not a census**, biased
      hardest against dense commercial belts. Size the loss first by counting
      `20 results` lines in `logs/night.log`. Quota is not a constraint — run 1
      used ~14% of the daily ceiling.

## Open — review deck (`preview/`)

- [ ] **Sort by review count, keep tier as a glyph.** Sorting is by `score`,
      whose `pain` half is miscalibrated; review count comes from Google and is
      the one input that is not our inference. Nothing is excluded by tier — all
      3,906 leads are in `index.json` (A:140 B:387 C:1126 X:2253), so the
      operator's own picks were ranked low, not dropped. — `preview/app.js:142`
- [ ] **Expose flags as filters.** Filters are `all`/`unreviewed`/`pitch`/tier
      only. Invisible in a screenshot and unreachable by eye: 920 sites on plain
      HTTP, 826 with broken images, 32 with expired certificates — the last is
      the strongest cold open in the dataset. — `preview/app.js:145`
- [ ] **Add a view for the no-website pool.** 259 dental businesses have no
      website at all, 211 of them with phone numbers — a larger pool than the 139
      scored dental leads, including clinics at 4,684 and 2,302 reviews. Maximum
      ability to pay, no incumbent to displace. They exist only in
      `qualified.json` and the deck cannot show them.

## Open — robustness before the next run

- [ ] **Raise audit concurrency.** Capture is wait-bound, not CPU-bound: 11.5s
      per capture at concurrency 1 vs ~12.5s at 8, because ~7s of each is
      deliberate settle sleeps. 8 vCPUs sat idle. Default is 4; the night driver
      passes 8. At 16 a full 18-vertical run goes from ~5h to ~3.3h.
      — `src/capture/index.js:45`, `ops/run-night.sh:11`
- [ ] **Add a hard per-capture deadline (~60s).** `--timeout` bounds navigation
      only, not the settle sequence or `_forceImageDecode`, so one capture ran
      677s against a 12s mean. Wrap the whole capture in `Promise.race` and keep
      whatever shots landed. Seen once in a tail sample; true frequency
      unmeasured — count outliers in `logs/night.log` first.
      — `src/capture/capture-domain.js`
- [ ] **Stop the score stage destroying `error.json`.** It unlinks the file on
      success, which erased the original robots errors and made the first
      recovery attempt find zero affected domains. Make it append-only or
      namespace it per stage. — `src/score/index.js:140`

## Deferred on purpose

- **`rules@2` retune.** Two known miscalibrations from the operator's hand-marked
  dental list: broken CTAs score near zero (`quoteForm` only detects a *missing*
  form, not one that posts nowhere), and `pain × pay` multiplication zeroes
  high-review low-pain leads (1,130 reviews, mild flaws → C/28 where the operator
  reads an obvious payer). Let the Disagreements view accumulate real marks
  first. Do not tune against fixtures. Bump `scorer` to `rules@2` when weights
  change. — `lib-scoring.js`
- **Broken-CTA detection.** Prerequisite for the retune. The `form-broken` angle
  exists in `config/angles.json:19` with nothing in `src/` feeding it.
- **Live iframe as a deck tab — undecided.** 19.6% of sites refuse framing (736
  `X-Frame-Options`, 278 CSP `frame-ancestors`, 835 either) and render as a
  permanent blank box. A stored capture also gives dated evidence, and a 390px
  iframe on desktop lays out at 390px — it cannot reproduce the
  980px-fallback-then-scale-down behaviour, which is the most sellable fact the
  tool produces.

## Done

- **`nextPageToken` field mask** — `src/discover/places.js:17`. **Local only;
  absent on the EC2 box.** Deploy it before the next run.
- **`full.png` dropped.** Captures write `desktop.webp` / `mobile.webp` in place;
  the deck's `F` tab is gone. Was 75% of image storage at 2.6 MB average. The
  ~10.7 GB of existing `full.png` on the box can be deleted separately —
  irreversible, not urgent.
- **robots.txt group parsing.** Blank lines were treated as group separators, so
  nine bots' `Disallow:/` merged into the wildcard group; 45 domains across 13
  verticals were wrongly refused and all 45 recovered. Group boundaries are a
  user-agent line following a rule line, never blank lines. 8 regression tests.
- **Greenfield bucket + dedup order.** Portal profiles (99acres, Practo,
  MakeMyTrip, WedMeGood) are kept as `aggregator-profile-only` and excluded from
  domain merge. Dedup ran before classification, so 39 of 40 brokers sharing a
  portal domain vanished entirely without even being recorded as skips.
- **Places rate limiting** — 8 req/sec limiter, backoff, `pageToken` retry.
- **Two missing pitch angles** — `mobile-tap-targets`, `mixed-content`. Five of
  seven fixture leads were falling through to `generic`.
- **`spec/W1-discovery.md` reconciled to the shipped code** — rate limit,
  no-merge-on-portal, new §2.6.1, two acceptance criteria.

## Note on `logs/`

`logs/night.log` is force-tracked run-1 evidence (1.4 MB). Two open items above
say to grep it — sizing the 20-result truncation, and counting capture outliers.
Drop it once both are closed.
