-- Run once as the database owner/superuser, in the application database.
-- Usage: psql "$ADMIN_URL" -v ops_password="'...'" -v app_db=app -f ops_ro.sql
-- Postgres must already have: shared_preload_libraries = 'pg_stat_statements'

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE ROLE ops_ro LOGIN PASSWORD :ops_password
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 3;

-- pg_monitor = read all pg_stat_* views (incl. other users' query text). No table access.
GRANT pg_monitor TO ops_ro;
GRANT CONNECT ON DATABASE :app_db TO ops_ro;
REVOKE CREATE ON SCHEMA public FROM ops_ro;

ALTER ROLE ops_ro SET default_transaction_read_only = on;
ALTER ROLE ops_ro SET statement_timeout = '5s';

-- Recommended: don't keep utility statements (ALTER ROLE … PASSWORD '…') in pg_stat_statements.
-- ALTER SYSTEM SET pg_stat_statements.track_utility = off;  SELECT pg_reload_conf();
