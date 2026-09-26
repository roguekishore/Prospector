# MySQL schema

Agreed with the operator 2026-09-26. **Final, and built:**
`db/migrations/0001_init.sql` is these statements, and `scripts/test-db.js`
asserts the columns, types and indexes back out of `information_schema`. Change
this file first, then the migration — where the two disagree, this file wins and
the migration is the bug.

Database `prospector` on mavdb (MySQL 8.4), and a local MySQL 8.0 for tests.
InnoDB, `utf8mb4`. Three tables: `verticals`, `companies`, `links`, plus the
migration runner's own `schema_migrations` (below).

Not here, on purpose: cities (one city; its slug is a column and its bbox stays
in `config/city.json`), runs, scores, agencies, contacts (emails are a column on
`companies`). Nothing in the pipeline detects or stores agencies; the operator
derives them from `links` when wanted.

## `verticals`

The source of truth, in place of the JSON file that used to be in `config/`.
The control panel's "add vertical" writes here; discover reads keywords from
here.

```sql
CREATE TABLE verticals (
  vertical_id  SMALLINT UNSIGNED AUTO_INCREMENT,
  slug         VARCHAR(64)  CHARACTER SET ascii NOT NULL,
  label        VARCHAR(128) NOT NULL,
  enabled      BOOLEAN      NOT NULL DEFAULT TRUE,
  priority     SMALLINT     NOT NULL,
  keywords     JSON         NOT NULL,          -- ["builders","promoters",…]
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (vertical_id),
  UNIQUE KEY by_slug (slug)
);
```

- The first migration seeds it from `config/verticals.json`, then the file is
  deleted.
- Slugs keep the existing rule (`^[a-z0-9][a-z0-9-]{0,63}$`,
  `src/control/verticals.js`).

## `companies`

One row per Google Places listing.

```sql
CREATE TABLE companies (
  company_id       BIGINT UNSIGNED AUTO_INCREMENT,
  place_id         VARCHAR(255)  CHARACTER SET ascii NOT NULL,
  city             VARCHAR(64)   CHARACTER SET ascii NOT NULL,
  vertical_id      SMALLINT UNSIGNED NOT NULL,

  -- discover (Places)
  name             VARCHAR(255)  NOT NULL,
  website_raw      VARCHAR(2048) NULL,
  domain           VARCHAR(253)  CHARACTER SET ascii NULL,
  rating           DECIMAL(2,1)  NULL,
  review_count     INT UNSIGNED  NULL,
  address          VARCHAR(512)  NULL,
  phone            VARCHAR(32)   NULL,
  lat              DECIMAL(9,6)  NULL,
  lng              DECIMAL(9,6)  NULL,
  business_status  VARCHAR(32)   NULL,
  primary_type     VARCHAR(64)   NULL,
  discovered_run   VARCHAR(40)   NOT NULL,
  discovered_at    DATETIME      NOT NULL,

  -- pipeline state
  status           TINYINT       NULL,
  skip_reason      VARCHAR(64)   NULL,
  extract_status   TINYINT       NULL,

  -- qualify
  final_url        VARCHAR(2048) NULL,
  http_status      SMALLINT      NULL,
  https_status     ENUM('ok','expired','none') NULL,
  cert_expires     DATE          NULL,
  qualified_at     DATETIME      NULL,

  -- capture and extract (written by ingest)
  capture_error    VARCHAR(64)   NULL,
  captured_at      DATETIME      NULL,
  extracted_at     DATETIME      NULL,
  email            VARCHAR(320)  NULL,     -- first email found on the site, lowercase

  -- operator decisions (written only by the deck)
  tier             ENUM('A','B','C','X') NULL,
  pitch            BOOLEAN       NOT NULL DEFAULT FALSE,
  note             TEXT          NULL,
  reviewed_at      DATETIME      NULL,

  updated_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (company_id),
  UNIQUE KEY by_place  (place_id),
  KEY by_site          (city, domain),
  KEY by_work          (city, vertical_id, status),
  CONSTRAINT fk_company_vertical FOREIGN KEY (vertical_id)
    REFERENCES verticals (vertical_id)
);
```

### Rows

- **`place_id` is unique, and that is the only identity rule.** Every place ID a
  scan returns is its own row. Discover no longer merges listings that share a
  website, in the same run or across runs.
- **First write wins.** When a later scan, in any vertical, returns a place ID
  that already exists, nothing about that row changes: not the Places fields,
  not `vertical_id`. Discover inserts with
  `ON DUPLICATE KEY UPDATE company_id = company_id` (a no-op, and unlike
  `INSERT IGNORE` it doesn't hide other errors).
- **Several rows can share one domain.** Capture and extract run once per
  distinct `(city, domain)`, since the S3 folder is `<city>/companies/<domain>/`.
  Ingest updates every row with that domain.

### `status`

| Value | Meaning | Set by |
|---|---|---|
| `NULL` | Discovered, not yet qualified | discover |
| `-1` | No usable website: none listed, aggregator/social only, or qualify skipped it | discover or qualify |
| `0` | Pending capture | qualify |
| `1` | Captured: `desktop.webp`, `mobile.webp`, `rendered.html` in S3 | ingest |
| `-2` | Capture failed: `error.json` present, capture not complete | ingest |

`skip_reason` holds why a row is `-1`: discover's `no-website`,
`unusable-website`, `aggregator-profile-only` / `aggregator-or-social-only`, or
qualify's `dead-host`, `http-error`, `parked`, `robots-disallow`,
`redirected-to-…`, `probe-error`.

### `extract_status`

| Value | Meaning |
|---|---|
| `NULL` | Not run (capture not done) |
| `1` | `extract.json` in S3 and loaded |
| `-2` | Extract failed; `capture --extract-only` retries these |

### Who writes which columns

Each writer names its columns explicitly and never touches another writer's.

| Writer | Where | Columns |
|---|---|---|
| discover | `src/discover/index.js` | Insert only: Places columns, `city`, `vertical_id`, `discovered_*`, `status` (`NULL` or `-1`), `skip_reason` |
| qualify | `src/qualify/index.js` | `status` (`0` or `-1`), `skip_reason`, the qualify columns. A new row whose domain is already known copies its sibling's qualify, capture and extract columns and links instead of probing |
| ingest | `src/ingest/index.js` | through `recordDomain` |
| local capture | `src/capture/index.js` | through `recordDomain`, straight after its own capture — a local capture is never uploaded, so nothing else would ever record it |
| capture --extract-only | `src/capture/extract/index.js` | through `recordDomain`, after re-extracting |
| `recordDomain` | `src/db/record.js` | `status` (`1` or `-2`), `capture_error`, `captured_at`, `extract_status`, `extracted_at`, `email`, and the domain's `links` rows |
| deck | `src/server/index.js` | `tier`, `pitch`, `note`, `reviewed_at`, and nothing else |
| control panel | `src/control/verticals.js` | `verticals` |

Three writers share one function on purpose. A domain captured on the box and a
domain captured by the Lambda have to end up describable by the same query, or
the deck shows one and not the other; putting the rules in `recordDomain` makes
that true by construction rather than by review.

## `schema_migrations`

The migration runner's own bookkeeping. Created by `src/db/migrate.js` before it
applies anything, which is why it is not in `0001` — that file would have to
create the table that records that it ran.

```sql
CREATE TABLE schema_migrations (
  version    INT          NOT NULL,   -- 1, from 0001_init.sql
  name       VARCHAR(255) NOT NULL,   -- 'init'
  applied_at DATETIME     NOT NULL,
  PRIMARY KEY (version)
);
```

MySQL has no transactional DDL, so a migration that fails half way leaves what
ran before it applied and the file unrecorded. Every migration is therefore
written to be safe to re-run — `CREATE TABLE IF NOT EXISTS`, and the same
discipline for any later `ALTER`.

`migrate` takes `SELECT GET_LOCK('prospector_migrate', 30)` around the whole run,
so two boxes shipping at once cannot both apply `0001`.

## `links`

Outside links only: social profiles and other domains. Links to the site's own
domain, `tel:`, `mailto:` and WhatsApp links are never written by extract.

```sql
CREATE TABLE links (
  link_id        BIGINT UNSIGNED AUTO_INCREMENT,
  company_id     BIGINT UNSIGNED NOT NULL,
  url            VARCHAR(2048) NOT NULL,
  target_domain  VARCHAR(253)  CHARACTER SET ascii NOT NULL,
  kind           ENUM('social','external') NOT NULL,
  region         ENUM('header','nav','main','aside','footer') NOT NULL,
  text           VARCHAR(120)  NULL,
  PRIMARY KEY (link_id),
  KEY by_target  (target_domain),
  CONSTRAINT fk_link_company FOREIGN KEY (company_id)
    REFERENCES companies (company_id) ON DELETE CASCADE
);
```

- Socials are identified by `target_domain` (instagram.com, facebook.com,
  youtube.com, …) and stored with `kind = 'social'`.
- When several companies share a domain, ingest writes the same links under
  each `company_id`. Any count across sites should use
  `COUNT(DISTINCT c.domain)` (joining `companies`), not a row count.

## `extract.json`

Extract writes one file per domain, `<city>/companies/<domain>/extract.json`,
replacing `links.json` and `contacts.json`. Its fields map one to one onto the
columns ingest writes, so loading it is a straight copy:

```jsonc
{
  "domain": "antaryaconcepts.com",
  "email": "contactus@antaryaconcepts.net",            // or null
  "links": [
    { "url": "https://www.instagram.com/antarya_concepts",
      "target_domain": "instagram.com", "kind": "social",
      "region": "footer", "text": "" }
  ]
}
```

| `extract.json` | Column |
|---|---|
| `email` | `companies.email` |
| `links[]` | one `links` row each, under every `company_id` with this domain |

So a company's S3 folder holds `desktop.webp`, `mobile.webp`, `rendered.html`,
`extract.json`, and `error.json` only when the capture failed.

## Re-ingest

For one `(city, domain)`, in one transaction: delete the `links` rows of every
company with that domain, insert the new ones, update the `companies` columns.
Running it twice changes nothing.

## Dropped from today's outputs

- Qualify: `wayback_first`, `server`, `generator_hint` (and qualify's Wayback API
  call), `viewport_meta`.
- Extract: phones, WhatsApp and postal address found on the site (Places already
  gives phone and address), opening hours, every email after the first, the
  Places phone and address fallbacks, per-contact `owner`, footer agency credit
  (`agency_credit`), and cross-site contact ownership. `config/agency-aliases.json`
  and `src/report/agency.js` go with them.
