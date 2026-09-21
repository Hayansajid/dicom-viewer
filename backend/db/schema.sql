-- Run this once against your MySQL server, e.g.:
--   mysql -u root -p < db/schema.sql
--
-- If you're upgrading an existing database created by an earlier version
-- of this project (before compressed/multi-frame support was added), the
-- simplest path is to drop and recreate:
--   DROP DATABASE dicom_viewer;
-- then re-run this file. If you need to keep existing rows, see the
-- migration snippet at the bottom instead.

CREATE DATABASE IF NOT EXISTS dicom_viewer
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE dicom_viewer;

CREATE TABLE IF NOT EXISTS series (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  series_uid          VARCHAR(128) NULL,
  study_uid           VARCHAR(128) NULL,
  patient_id          VARCHAR(64)  NULL,
  patient_name        VARCHAR(255) NULL,
  modality            VARCHAR(16)  NULL,
  series_description  VARCHAR(255) NULL,
  study_date          VARCHAR(10)  NULL,
  pixel_spacing       VARCHAR(32)  NULL,
  transfer_syntax_uid VARCHAR(255) NULL,
  slice_count         INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_patient (patient_id)
);

-- One row per *viewable image*: a plain single-frame file produces exactly
-- one row, while a multi-frame file (e.g. a tomosynthesis volume) produces
-- one row per frame, all sharing the same storage_path and distinguished by
-- frame_index. The frontend never needs to know which case it's looking at.
CREATE TABLE IF NOT EXISTS slices (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  series_id           INT NOT NULL,
  file_name           VARCHAR(255) NOT NULL,
  storage_path        VARCHAR(512) NOT NULL,
  frame_index         INT NOT NULL DEFAULT 0,
  instance_number     INT NULL,
  slice_location      DOUBLE NULL,
  sort_order          INT NOT NULL,
  rows_px             INT NULL,
  cols_px             INT NULL,
  is_color            TINYINT(1) NOT NULL DEFAULT 0,
  window_center       DOUBLE NULL,
  window_width        DOUBLE NULL,
  rescale_slope       DOUBLE NOT NULL DEFAULT 1,
  rescale_intercept   DOUBLE NOT NULL DEFAULT 0,
  CONSTRAINT fk_slices_series
    FOREIGN KEY (series_id) REFERENCES series(id)
    ON DELETE CASCADE,
  INDEX idx_series_order (series_id, sort_order)
);

-- ---------------------------------------------------------------------
-- Migration for an existing database (run instead of DROP/recreate if you
-- have data you want to keep - existing rows will default to frame_index=0
-- and is_color=0, which is correct for any file uploaded before this
-- change, since none of them were multi-frame or color):
--
-- ALTER TABLE series ADD COLUMN transfer_syntax_uid VARCHAR(255) NULL;
-- ALTER TABLE slices ADD COLUMN frame_index INT NOT NULL DEFAULT 0 AFTER storage_path;
-- ALTER TABLE slices ADD COLUMN is_color TINYINT(1) NOT NULL DEFAULT 0 AFTER cols_px;
-- ALTER TABLE series ADD COLUMN study_uid VARCHAR(128) NULL AFTER series_uid;
-- ALTER TABLE series ADD COLUMN patient_id VARCHAR(64) NULL AFTER study_uid;
-- ALTER TABLE series ADD COLUMN patient_name VARCHAR(255) NULL AFTER patient_id;
-- ALTER TABLE series ADD INDEX idx_patient (patient_id);
-- ---------------------------------------------------------------------
