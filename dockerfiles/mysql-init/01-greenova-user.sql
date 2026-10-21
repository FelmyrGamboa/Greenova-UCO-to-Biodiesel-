-- Runs once, when the MySQL container starts with an empty data volume, right after
-- 00-greenova_db_ver2.sql (the project's dump, mounted unchanged by docker-compose.yaml).
--
-- The dump creates greenova@localhost. The backend runs in its own container, so MySQL sees it
-- coming from another address: this adds the same user for any address, also without a password.
-- The port is published on 127.0.0.1 only, so it can't be reached from the Wi-Fi.
CREATE USER IF NOT EXISTS 'greenova'@'%' IDENTIFIED BY '';
GRANT ALL PRIVILEGES ON greenova_db.* TO 'greenova'@'%';
FLUSH PRIVILEGES;
