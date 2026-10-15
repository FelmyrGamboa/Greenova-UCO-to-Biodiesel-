-- Greenova MySQL database (greenova_db): the 8 tables the backend uses.
--
-- Same tables, columns, keys and relationships as greenova_db.sql (the HeidiSQL export), with
-- three differences so it runs on both MySQL 8 (Windows laptop) and MariaDB 10.11+ (Raspberry Pi):
--   * no COLLATE utf8mb4_0900_ai_ci (MariaDB before 11.4.5 doesn't know it): the server's
--     default utf8mb4 collation is used;
--   * settings has 5 newer settings the app uses (magnesolDose, bentoniteDose, defaultAdsorbent,
--     autoAdvance, magnesolPrice); the backend adds them by itself to an older settings table;
--   * settings defaults follow the current rules (FFA threshold 1%, centrifuge drain 2 min,
--     current 1-2 A).
--
-- Run it once (HeidiSQL: File > Load SQL file > Execute, or: mysql -u root -p < schema.sql).
-- The backend also creates any missing table by itself when it starts, using the statements below.
-- Parents come before children, so the foreign keys can be created in this order.

CREATE DATABASE IF NOT EXISTS `greenova_db` DEFAULT CHARACTER SET utf8mb4;
USE `greenova_db`;

-- One row per batch (the parent of every batch_* table).
CREATE TABLE IF NOT EXISTS `production_batches` (
  `batch_id` varchar(50) NOT NULL,
  `production_date` date NOT NULL,
  `oil_volume_ml` decimal(12,3) NOT NULL,
  `oil_mass_g` decimal(12,3) NOT NULL,
  `yield_percent` decimal(7,3) NOT NULL,
  `duration_seconds` decimal(12,3) NOT NULL,
  `energy_value` decimal(14,4) NOT NULL,
  `energy_unit` varchar(20) DEFAULT NULL,
  `batch_status` varchar(30) NOT NULL,
  `ffa_percent` decimal(7,3) NOT NULL,
  `ffa_above_strip` tinyint(1) NOT NULL DEFAULT '0',
  `esterification_run` tinyint(1) NOT NULL DEFAULT '0',
  `esterification_voltage` decimal(10,3) DEFAULT NULL,
  `esterification_time_seconds` decimal(12,3) DEFAULT NULL,
  `esterification_stirring_rpm` decimal(10,2) DEFAULT NULL,
  `esterification_current_a` decimal(10,4) DEFAULT NULL,
  `temperature_c` decimal(7,2) NOT NULL,
  `reaction_time_seconds` decimal(12,3) NOT NULL,
  `stirring_speed_rpm` decimal(10,2) NOT NULL,
  `voltage_v` decimal(10,3) NOT NULL,
  `current_a` decimal(10,4) NOT NULL,
  `methanol_ratio` decimal(10,4) NOT NULL,
  `biodiesel_output_ml` decimal(12,3) NOT NULL,
  `catalyst_type` varchar(50) NOT NULL,
  `adsorbent` varchar(100) NOT NULL,
  `catalyst_to_weigh_g` decimal(12,4) NOT NULL,
  `notes` text,
  `created_at` datetime(6) NOT NULL,
  PRIMARY KEY (`batch_id`),
  KEY `idx_batch_date` (`production_date`),
  KEY `idx_batch_status` (`batch_status`),
  KEY `idx_batch_catalyst` (`catalyst_type`),
  KEY `idx_batch_adsorbent` (`adsorbent`),
  KEY `idx_batch_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Lab result of a batch (1 batch : 0 or 1 result). One row per batch_id (uq_lab_batch), updated
-- in place when the result changes; tested_at is the time the result was recorded.
CREATE TABLE IF NOT EXISTS `batch_lab_results` (
  `lab_result_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `batch_id` varchar(50) NOT NULL,
  `result_status` varchar(30) NOT NULL,
  `lab_reference` varchar(100) DEFAULT NULL,
  `test_name` varchar(100) DEFAULT NULL,
  `measured_value` decimal(14,6) DEFAULT NULL,
  `unit` varchar(20) DEFAULT NULL,
  `tested_at` datetime(6) DEFAULT NULL,
  `notes` text,
  PRIMARY KEY (`lab_result_id`),
  UNIQUE KEY `uq_lab_batch` (`batch_id`),
  KEY `idx_lab_status` (`result_status`),
  KEY `idx_lab_reference` (`lab_reference`),
  CONSTRAINT `fk_lab_batch` FOREIGN KEY (`batch_id`) REFERENCES `production_batches` (`batch_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Materials used by a batch (1 batch : many materials, one row per material name).
CREATE TABLE IF NOT EXISTS `batch_materials` (
  `material_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `batch_id` varchar(50) NOT NULL,
  `material_name` varchar(100) NOT NULL,
  `quantity` decimal(14,6) NOT NULL,
  `unit` varchar(20) NOT NULL,
  PRIMARY KEY (`material_id`),
  UNIQUE KEY `uq_batch_material` (`batch_id`,`material_name`),
  KEY `idx_material_name` (`material_name`),
  CONSTRAINT `fk_material_batch` FOREIGN KEY (`batch_id`) REFERENCES `production_batches` (`batch_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `chk_material_quantity` CHECK ((`quantity` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Purification (dry wash) record of a batch (1 batch : 0 or 1 record).
CREATE TABLE IF NOT EXISTS `batch_purification` (
  `purification_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `batch_id` varchar(50) NOT NULL,
  `target_temperature_c` decimal(7,2) NOT NULL,
  `highest_temperature_c` decimal(7,2) NOT NULL,
  `heating_time_seconds` decimal(12,3) NOT NULL,
  `hold_time_seconds` decimal(12,3) NOT NULL,
  `flow_time_seconds` decimal(12,3) NOT NULL,
  `drain_time_seconds` decimal(12,3) NOT NULL,
  `contact_time_seconds` decimal(12,3) NOT NULL,
  `settling_time_seconds` decimal(12,3) NOT NULL,
  `cooling_time_seconds` decimal(12,3) NOT NULL,
  `magnesol_added` tinyint(1) NOT NULL,
  `oil_weight_g` decimal(12,3) NOT NULL,
  `expected_biodiesel_ml` decimal(12,3) DEFAULT NULL,
  `planned_flow_seconds` decimal(12,3) DEFAULT NULL,
  `is_automatic` tinyint(1) NOT NULL,
  `warning` text,
  `safety_stop_occurred` tinyint(1) NOT NULL,
  `safety_stop_reason` text,
  `output_weight_g` decimal(12,3) NOT NULL,
  `stirring_speed_rpm` decimal(10,2) NOT NULL,
  `magnesol_g` decimal(12,3) NOT NULL,
  `adsorbent` varchar(100) NOT NULL,
  `adsorbent_g` decimal(12,3) NOT NULL,
  `heater_on_seconds` decimal(12,3) NOT NULL,
  PRIMARY KEY (`purification_id`),
  UNIQUE KEY `uq_purification_batch` (`batch_id`),
  CONSTRAINT `fk_purification_batch` FOREIGN KEY (`batch_id`) REFERENCES `production_batches` (`batch_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Timeline of a batch (1 batch : many events, in order of event_sequence).
CREATE TABLE IF NOT EXISTS `batch_timeline` (
  `event_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `batch_id` varchar(50) NOT NULL,
  `event_sequence` int unsigned NOT NULL,
  `event_label` varchar(500) NOT NULL,
  `event_time` datetime(6) NOT NULL,
  PRIMARY KEY (`event_id`),
  UNIQUE KEY `uq_batch_event_sequence` (`batch_id`,`event_sequence`),
  KEY `idx_event_time` (`event_time`),
  KEY `idx_batch_event_time` (`batch_id`,`event_time`),
  CONSTRAINT `fk_timeline_batch` FOREIGN KEY (`batch_id`) REFERENCES `production_batches` (`batch_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Esterification stages of a batch (1 batch : many stages, one row per stage number).
CREATE TABLE IF NOT EXISTS `esterification_stages` (
  `stage_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `batch_id` varchar(50) NOT NULL,
  `stage_number` smallint unsigned NOT NULL,
  `stage_data` json NOT NULL,
  PRIMARY KEY (`stage_id`),
  UNIQUE KEY `uq_batch_stage` (`batch_id`,`stage_number`),
  CONSTRAINT `fk_esterification_batch` FOREIGN KEY (`batch_id`) REFERENCES `production_batches` (`batch_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Where an ongoing ("In Progress") batch is on the website's Process page (1 batch : 0 or 1 row),
-- so the operator can continue it from any device. Removed when the batch is completed or cancelled.
CREATE TABLE IF NOT EXISTS `batch_progress` (
  `batch_id` varchar(50) NOT NULL,
  `current_stage` varchar(50) NOT NULL,
  `state_data` json NOT NULL,
  `updated_at` datetime(6) NOT NULL,
  PRIMARY KEY (`batch_id`),
  CONSTRAINT `fk_progress_batch` FOREIGN KEY (`batch_id`) REFERENCES `production_batches` (`batch_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The Settings page and process constants: one row, id = 1. Column names are the website's keys.
CREATE TABLE IF NOT EXISTS `settings` (
  `id` int NOT NULL DEFAULT '1',
  `systemName` varchar(150) NOT NULL DEFAULT 'Greenova Production System',
  `operator` varchar(100) NOT NULL DEFAULT 'Operator 01',
  `units` varchar(20) NOT NULL DEFAULT 'metric',
  `format` varchar(50) NOT NULL DEFAULT 'B-{YEAR}-{SEQ}',
  `methanolRemovalTime` decimal(10,2) NOT NULL DEFAULT '10.00',
  `contactTime` decimal(10,2) NOT NULL DEFAULT '15.00',
  `settlingTime` decimal(10,2) NOT NULL DEFAULT '10.00',
  `maxDrainTemperature` decimal(10,2) NOT NULL DEFAULT '50.00',
  `thermalFuseRating` decimal(10,2) DEFAULT NULL,
  `purificationAutoStart` tinyint(1) NOT NULL DEFAULT '1',
  `magnesolDose` decimal(10,2) NOT NULL DEFAULT '1.00',
  `bentoniteDose` decimal(10,2) NOT NULL DEFAULT '2.00',
  `defaultAdsorbent` varchar(100) NOT NULL DEFAULT 'Magnesol',
  `autoAdvance` tinyint(1) NOT NULL DEFAULT '1',
  `esterificationDesignFfa` decimal(10,2) NOT NULL DEFAULT '10.00',
  `stripMaxFfa` decimal(10,2) NOT NULL DEFAULT '5.00',
  `ffaRangeBoundaries` varchar(100) NOT NULL DEFAULT '0,2,4,5',
  `ffaThreshold` decimal(10,2) NOT NULL DEFAULT '1.00',
  `ffaTarget` decimal(10,2) NOT NULL DEFAULT '1.00',
  `pumpCatalystRate` decimal(10,2) NOT NULL DEFAULT '100.00',
  `pumpAcidRate` decimal(10,2) NOT NULL DEFAULT '100.00',
  `reactorDrainTime` decimal(10,2) NOT NULL DEFAULT '1.00',
  `centrifugeDrainTime` decimal(10,2) NOT NULL DEFAULT '2.00',
  `centrifugeSpinDownTime` decimal(10,2) NOT NULL DEFAULT '30.00',
  `pumpNoFlowSeconds` decimal(10,2) NOT NULL DEFAULT '20.00',
  `provenBatchCount` int NOT NULL DEFAULT '3',
  `provenYieldTolerance` decimal(10,2) NOT NULL DEFAULT '2.00',
  `oilPrice` decimal(12,2) NOT NULL DEFAULT '45.00',
  `methanolPrice` decimal(12,2) NOT NULL DEFAULT '70.00',
  `kohPrice` decimal(12,2) NOT NULL DEFAULT '180.00',
  `naohPrice` decimal(12,2) NOT NULL DEFAULT '160.00',
  `sulfuricAcidPrice` decimal(12,2) NOT NULL DEFAULT '120.00',
  `acetonePrice` decimal(12,2) NOT NULL DEFAULT '100.00',
  `bentonitePrice` decimal(12,2) NOT NULL DEFAULT '80.00',
  `magnesolPrice` decimal(12,2) NOT NULL DEFAULT '250.00',
  `electricityPrice` decimal(12,2) NOT NULL DEFAULT '12.00',
  `dieselPrice` decimal(12,2) NOT NULL DEFAULT '55.00',
  `oilMolarMass` decimal(12,3) NOT NULL DEFAULT '880.000',
  `kohPurity` decimal(6,2) NOT NULL DEFAULT '90.00',
  `naohPurity` decimal(6,2) NOT NULL DEFAULT '98.00',
  `oilDensity` decimal(8,4) NOT NULL DEFAULT '0.9200',
  `biodieselDensity` decimal(8,4) NOT NULL DEFAULT '0.8800',
  `oilMinimumVolumeMl` decimal(12,2) NOT NULL DEFAULT '100.00',
  `oilMaximumVolumeMl` decimal(12,2) NOT NULL DEFAULT '1000.00',
  `catalystLoading` decimal(10,4) NOT NULL DEFAULT '0.0100',
  `acetoneFraction` decimal(10,4) NOT NULL DEFAULT '0.1000',
  `bentoniteFraction` decimal(10,4) NOT NULL DEFAULT '0.0200',
  `methanolRatioMin` decimal(10,2) NOT NULL DEFAULT '6.00',
  `methanolRatioMax` decimal(10,2) NOT NULL DEFAULT '9.00',
  `methanolRatioDefault` decimal(10,2) NOT NULL DEFAULT '7.00',
  `esterificationVoltageMin` decimal(10,2) NOT NULL DEFAULT '10.00',
  `esterificationVoltageMax` decimal(10,2) NOT NULL DEFAULT '30.00',
  `esterificationVoltageDefault` decimal(10,2) NOT NULL DEFAULT '20.00',
  `esterificationTimeMin` decimal(10,2) NOT NULL DEFAULT '30.00',
  `esterificationTimeMax` decimal(10,2) NOT NULL DEFAULT '180.00',
  `esterificationTimeDefault` decimal(10,2) NOT NULL DEFAULT '120.00',
  `esterificationStirringMin` decimal(10,2) NOT NULL DEFAULT '400.00',
  `esterificationStirringMax` decimal(10,2) NOT NULL DEFAULT '700.00',
  `esterificationStirringDefault` decimal(10,2) NOT NULL DEFAULT '500.00',
  `esterificationCurrentMin` decimal(10,3) NOT NULL DEFAULT '1.000',
  `esterificationCurrentMax` decimal(10,3) NOT NULL DEFAULT '2.000',
  `esterificationCurrentDefault` decimal(10,3) NOT NULL DEFAULT '1.000',
  `transesterificationVoltageMin` decimal(10,2) NOT NULL DEFAULT '10.00',
  `transesterificationVoltageMax` decimal(10,2) NOT NULL DEFAULT '30.00',
  `transesterificationVoltageDefault` decimal(10,2) NOT NULL DEFAULT '30.00',
  `transesterificationTimeMin` decimal(10,2) NOT NULL DEFAULT '30.00',
  `transesterificationTimeMax` decimal(10,2) NOT NULL DEFAULT '180.00',
  `transesterificationTimeDefault` decimal(10,2) NOT NULL DEFAULT '120.00',
  `transesterificationStirringMin` decimal(10,2) NOT NULL DEFAULT '400.00',
  `transesterificationStirringMax` decimal(10,2) NOT NULL DEFAULT '700.00',
  `transesterificationStirringDefault` decimal(10,2) NOT NULL DEFAULT '500.00',
  `transesterificationCurrentMin` decimal(10,3) NOT NULL DEFAULT '1.000',
  `transesterificationCurrentMax` decimal(10,3) NOT NULL DEFAULT '2.000',
  `transesterificationCurrentDefault` decimal(10,3) NOT NULL DEFAULT '1.000',
  `separationTime` decimal(10,2) NOT NULL DEFAULT '10.00',
  `separationSpeed` decimal(10,2) NOT NULL DEFAULT '2600.00',
  `reactionMaximumTemperature` decimal(10,2) NOT NULL DEFAULT '60.00',
  `stirrerMaxRpm` decimal(10,2) NOT NULL DEFAULT '900.00',
  `centrifugeMaxRpm` decimal(10,2) NOT NULL DEFAULT '3000.00',
  `purificationStirrerMaxRpm` decimal(10,2) NOT NULL DEFAULT '600.00',
  `heaterPowerWatts` decimal(12,2) NOT NULL DEFAULT '0.00',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
