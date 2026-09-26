-- 0001_init — the three tables of docs/SCHEMA.md.
--
-- `IF NOT EXISTS` on each: MySQL DDL auto-commits, so a file that fails on its
-- third statement leaves the first two applied and unrecorded. Re-running this
-- has to be safe, or the only recovery from a half-applied migration is by hand.
--
-- Runs on MySQL 8.0.39 (the laptop) and 8.4 (mavdb). `utf8mb4_0900_ai_ci` is
-- present on both.

CREATE TABLE IF NOT EXISTS verticals (
  vertical_id  SMALLINT UNSIGNED AUTO_INCREMENT,
  slug         VARCHAR(64)  CHARACTER SET ascii NOT NULL,
  label        VARCHAR(128) NOT NULL,
  enabled      BOOLEAN      NOT NULL DEFAULT TRUE,
  priority     SMALLINT     NOT NULL,
  keywords     JSON         NOT NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (vertical_id),
  UNIQUE KEY by_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS companies (
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

  -- capture and extract (written through src/db/record.js)
  capture_error    VARCHAR(64)   NULL,
  captured_at      DATETIME      NULL,
  extracted_at     DATETIME      NULL,
  email            VARCHAR(320)  NULL,

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS links (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
