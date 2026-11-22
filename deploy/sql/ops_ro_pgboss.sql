-- Optional: for applications that use pg-boss (https://github.com/timgit/pg-boss) in the default schema
-- "pgboss". Run once as the database owner, after pg-boss has created its schema, and after ops_ro.sql.
-- Usage: psql "$ADMIN_URL" -f ops_ro_pgboss.sql

-- Only the counters pg-boss keeps per queue for its own monitoring. Nothing on pgboss.job: it holds every
-- job's payload (data) and result or error (output). singletons_active is left out too: singleton keys
-- are often user or order ids.
GRANT USAGE ON SCHEMA pgboss TO ops_ro;
GRANT SELECT (
  name, policy, dead_letter,
  ready_count, deferred_count, active_count, failed_count, queued_count, warning_queued,
  created_delta, completed_delta, failed_delta, delta_seconds, ready_oldest_seconds, monitor_on
) ON pgboss.queue TO ops_ro;
