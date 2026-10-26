# @esrs/database — schema, migrations and seeds

PostgreSQL schema for ESRS, organised as ordered SQL migrations plus idempotent seed files and a
small runner that wraps [`node-pg-migrate`](https://github.com/salsify/node-pg-migrate).
Design rationale lives in [`docs/database-design.md`](../docs/database-design.md).

## Layout

```
database/
├── migrations/            # 001…014, applied in filename order
│   └── 0NN_topic.sql       # "-- Up Migration" / "-- Down Migration" sections
├── seeds/                  # reference data + demo data (safe to re-run)
├── scripts/
│   ├── run.mjs             # CLI: up | down | status | seed | reset | make
│   ├── config.mjs          # env-file cascade + DATABASE_URL resolution
│   ├── seed.mjs            # applies seeds, injects the demo password hash
│   └── status.mjs          # applied vs pending (node-pg-migrate has no `status`)
└── test/enumParity.test.ts # contract test C-02: SQL enums/defaults == @esrs/shared
```

## Commands (run from the repository root)

| Command               | What it does                                                     |
| --------------------- | ---------------------------------------------------------------- |
| `npm run db:up`       | start the PostgreSQL container (`docker compose up -d postgres`) |
| `npm run db:migrate`  | apply every pending migration                                    |
| `npm run db:status`   | list each migration as `applied` or `pending`                    |
| `npm run db:seed`     | apply reference + demo data (idempotent)                         |
| `npm run db:rollback` | revert the last migration (all of them, in this runner)          |
| `npm run db:reset`    | `down all` → `up` → `seed` — **development only, destructive**   |
| `npm run db:down`     | stop the container                                               |

Configuration is read from `.env`, `.env.local`, `.env.<NODE_ENV>` and `.env.<NODE_ENV>.local` in
the repository root, then `database/.env`. See [`database/.env.example`](./.env.example); the real
files are git-ignored. If no `DATABASE_URL` (and no `POSTGRES_*` variables) is present the runner
explains how to configure it instead of throwing.

## Migration rules

1. One logical change per numbered file; never edit an applied migration — add the next one.
   `npm run db:make <name>` creates the next file from the SQL template.
2. Every migration needs a `-- Down Migration` section (checked by `database/test`).
3. Add-only columns must carry a `DEFAULT` or a backfill step, so a deploy never locks reads.
4. Lifecycle rules are **not** encoded as triggers: the state machine in
   `backend/src/domain/request/stateMachine.ts` is the authority, the database keeps cheap
   `CHECK`s and foreign keys.
5. Enum labels must match `@esrs/shared`. The parity test fails the build if they diverge.

## Seeds and credentials

`migrations/010` and `migrations/014` insert the rows the API cannot start without (the four SLA
policies and the `app_settings` defaults) using `ON CONFLICT DO NOTHING`. `seeds/` holds the
editable catalogue and the demo dataset.

No password or token is committed anywhere. `seeds/002_demo_data.sql` contains the placeholder
`{{DEMO_PASSWORD_HASH}}`, which `npm run db:seed` replaces with a bcrypt(cost 12) hash of
`SEED_DEMO_PASSWORD`. That variable has **no default in the code**: if a seed references the token and
the variable is unset, seeding stops with an instruction to set it in `database/.env` (the
`.env.example` ships a fill-in placeholder). Demo accounts are seeded with
`must_change_password = true`, so a first login is always forced through a password change.
