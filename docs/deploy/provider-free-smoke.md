# Provider-free smoke launcher

Use the repository launcher for local or staging smoke work that must not use
an operator's Paperclip database:

```sh
run_root="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-provider-free.XXXXXX")"
env -u DATABASE_URL -u DATABASE_MIGRATION_URL \
  PAPERCLIP_PROVIDER_FREE_RUN_ROOT="$run_root" \
  pnpm smoke:provider-free
```

The launcher fails before process startup when it inherits `DATABASE_URL` or
`DATABASE_MIGRATION_URL`, when the launch directory's `.env` declares either
binding, when the run root is not absolute, or when the root is non-empty. It
also disables launch-cwd dotenv loading to prevent a post-preflight file change
from rehydrating an external database binding. It binds to loopback, supplies
fresh run-owned home/config/context paths, disables database backups, and
selects the embedded PostgreSQL path.

Before accepting smoke evidence, verify the server banner says
`embedded-postgres`, its database and config paths are under the supplied run
root, and `/api/health` returns `status: ok`. The launcher does not authorize a
provider call, a production action, or reuse of historical state.
