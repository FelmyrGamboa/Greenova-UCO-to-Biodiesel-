-- Runs once, the first time the MySQL container starts with an empty data volume
-- (docker compose down -v, then up, runs it again).
--
-- The user the backend logs in with: greenova, no password, from any container ('%').
-- It may do anything in greenova_db; the backend creates the 8 tables there by itself (schema.sql).

CREATE USER IF NOT EXISTS 'greenova'@'%' IDENTIFIED BY '';
GRANT ALL PRIVILEGES ON `greenova_db`.* TO 'greenova'@'%';
FLUSH PRIVILEGES;
