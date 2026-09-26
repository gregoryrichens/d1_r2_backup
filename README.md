# D1 Backup Worker

A small Cloudflare Worker that creates a scheduled backup of a Cloudflare D1 database and stores the resulting SQL export in a private Cloudflare R2 bucket.

The goal is simple: **make the database recoverable if something goes wrong with the live D1 database.**

## Why this exists

The D1 database is the primary source of truth for application data. A backup gives us an independent copy that can be retained beyond D1's normal point-in-time recovery window and used to rebuild the database if necessary.

This worker is intentionally narrow in scope. It does one thing:

> Export the production D1 database on a schedule and store the export in R2.

There is no application traffic, user interface, or public API associated with the backup process.

## Architecture

```text
                 Cloudflare

   D1 (production database)
               |
               | D1 Export REST API
               v
       d1-backup Worker
               |
               | scheduled() via Cron Trigger
               |
               | SQL export
               v
        R2: backups
               |
               v
     dated .sql backup files
```

The worker uses two different Cloudflare mechanisms:

- **D1 REST API** — starts and polls the database export.
- **R2 Worker binding** — writes the completed SQL export directly to the `backups` bucket.

Everything runs inside Cloudflare.

## Cloudflare resources

| Resource | Name | Purpose |
|---|---|---|
| Worker | `d1-backup` | Runs the backup code |
| D1 API token | `d1-backup-export` | Allows the Worker to call the D1 export API |
| R2 bucket | `backups` | Stores the backup files |
| Worker secret | `D1_REST_API_TOKEN` | Stores the API token securely at runtime |
| Worker variable | `ACCOUNT_ID` | Cloudflare account containing the D1 database |
| Worker variable | `DATABASE_ID` | ID of the production D1 database |
| R2 binding | `BACKUP_BUCKET` | Points the Worker at `backups` |

## Backup schedule

The Worker is invoked by a Cloudflare Cron Trigger. The production schedule should be configured in the Cloudflare dashboard during a low-traffic period.

Cron expressions use **UTC**, so a schedule intended to run at 2:00 AM Mountain Time must account for daylight-saving time. A fixed UTC schedule may shift by one hour seasonally.

For testing, a 15-minute schedule can be used temporarily:

```text
*/15 * * * *
```

The production schedule should be changed to the desired daily UTC time after testing.

## What happens during a backup

1. The Cron Trigger invokes the Worker's `scheduled()` handler.
2. The Worker calls the D1 Export API.
3. D1 returns a bookmark identifying the database state being exported.
4. The Worker polls the export until it is complete.
5. D1 returns a temporary signed download URL for the SQL export.
6. The Worker downloads the export with a per-request timeout.
7. The Worker streams the SQL directly into the `backups` R2 bucket.
8. The backup is stored under a dated object key.

Example object layout:

```text
production/
  2026/
    09/
      25/
        2026-09-25T08-00-00Z_<bookmark>.sql
```

The D1 bookmark is retained in the filename and object metadata so the backup can be associated with the database state that produced it.

## Security model

The Worker does not need a public HTTP endpoint for normal operation. The `workers.dev` production and preview URLs should remain disabled unless there is a specific reason to expose them.

The D1 export credential is stored as a Cloudflare Worker secret and is **not** committed to this repository.

The R2 bucket should remain private. The Worker accesses it through the `BACKUP_BUCKET` binding rather than through an R2 access key.

The repository should never contain:

- the value of `D1_REST_API_TOKEN`
- Cloudflare API tokens
- database credentials
- production backup files

## Configuration in Cloudflare

The Worker is managed from:

**Cloudflare Dashboard → Workers & Pages → `d1-backup`**

Useful locations:

### Code

**Edit Code**

Contains the Worker implementation.

### Variables and Secrets

**Settings → Variables and Secrets**

Required values:

```text
ACCOUNT_ID
DATABASE_ID
D1_REST_API_TOKEN   (secret)
```

### R2 binding

**Settings → Bindings**

Required binding:

```text
BACKUP_BUCKET → backups
```

### Schedule

**Settings → Triggers → Cron Triggers**

This controls when the backup runs.

### Public access

**Settings → Domains & Routes**

The Worker does not require a public `workers.dev` URL for Cron execution. Keep production and preview URLs disabled unless they are intentionally needed.

## Recovery

A backup is useful only if it can be restored.

The recovery process is:

```text
R2 backup .sql file
        |
        v
Temporary/replacement D1 database
        |
        v
Import SQL
        |
        v
Verify schema + critical data
```

A restore test should be performed periodically using a non-production D1 database. At minimum, verify that:

- expected tables exist
- critical row counts are plausible
- important records can be queried
- the application can be pointed at the restored database in a controlled test environment

Do not use the production D1 database for restore testing.

## Retention

R2 lifecycle rules should be used to control how long historical backups are kept. The Worker should not be responsible for deleting old backups.

A typical policy for this project is to keep daily backups for approximately 90 days.

For additional protection, consider R2 Bucket Lock / retention controls so recent backups cannot be deleted prematurely.

## Failure behavior

The Worker treats these conditions as backup failures:

- D1 rejects the export request
- D1 reports an export error
- the export does not complete within the configured maximum export time
- an HTTP request times out
- the completed SQL export cannot be downloaded
- the R2 write fails

The code includes an explicit timeout for individual HTTP requests and an overall export timeout so a stalled operation cannot consume the entire Worker invocation indefinitely.

## Database size assumption

This Worker is intended for a relatively small D1 database. The current expected maximum database size is approximately **10 MB**.

That makes a simple Cron-triggered Worker practical. If the database grows substantially or export times approach the Worker execution limit, the backup implementation should be reconsidered in favor of a durable Cloudflare Workflow.

## Operational principle

The backup system is deliberately boring:

- D1 remains the production database.
- Cron starts the job.
- The Worker exports D1.
- R2 stores the resulting SQL snapshot.
- R2 controls retention.
- A separate D1 database can be used to verify recovery.

The backup system should not become part of the application logic or request path.

## Development and deployment

The Worker can be deployed through the repository's normal Cloudflare deployment process. The Cloudflare dashboard is the authoritative place for runtime secrets, bindings, schedules, and the deployed Worker configuration.

When changing the Worker code, make sure the change preserves the following contract:

```text
scheduled()
  -> D1 export API
  -> poll until complete
  -> download signed SQL export
  -> write to BACKUP_BUCKET
```

A code change should be followed by a manual backup run and verification that a new object appears in `backups`.

## Checklist after deployment

- [ ] Worker `d1-backup` exists
- [ ] Public Worker URLs are disabled
- [ ] `ACCOUNT_ID` configured
- [ ] `DATABASE_ID` configured
- [ ] `D1_REST_API_TOKEN` configured as a secret
- [ ] `BACKUP_BUCKET` bound to `backups`
- [ ] Cron Trigger configured
- [ ] Manual backup succeeds
- [ ] `.sql` object appears in `backups`
- [ ] R2 retention rule configured
- [ ] Restore test completed successfully

