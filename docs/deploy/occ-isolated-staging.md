# OCC isolated staging lane

This lane runs a Paperclip commit as an isolated Compose project. It does not use the WordPress staging host or any production Paperclip volume.

## Isolation contract

- The project, network, database volume, runtime volume, ports, and secrets have staging-only names.
- The HTTP port binds to `127.0.0.1`. Browser QA must use an operator-approved private tunnel to that loopback endpoint.
- The stack mounts only two host secret files. It does not mount agent homes, OneCLI data, GitHub data, WooCommerce data, customer data, or production Paperclip data.
- The bootstrap creates one synthetic admin account in the new staging database. It does not clone production data.
- The image tag is the full git SHA. The image also records that SHA in the build metadata.

## Reviewed host command packet

Run these commands only on the dedicated Paperclip staging host after this change is reviewed. Use a managed secret directory outside the repository. The files must contain new staging-only random values.

```sh
export PAPERCLIP_STAGING_COMMIT=<reviewed-full-git-sha>
export PAPERCLIP_STAGING_PROJECT=occ-paperclip-staging
export PAPERCLIP_PRODUCTION_PROJECT=<exact-production-compose-project>
export PAPERCLIP_STAGING_PORT=3310
export PAPERCLIP_STAGING_PUBLIC_URL=http://127.0.0.1:3310
export PAPERCLIP_STAGING_SECRET_DIR=/run/occ-paperclip-staging
./scripts/staging-paperclip-deploy.sh

export PAPERCLIP_STAGING_ADMIN_PASSWORD=<runtime-only-synthetic-password>
./scripts/staging-paperclip-bootstrap.sh
```

Give Browser QA the explicit private tunnel endpoint that maps to `127.0.0.1:3310`. Do not expose the port on a public interface.

## Rollback and teardown

To roll back, check out the prior reviewed SHA and run the deploy packet again with that full SHA. The receipt records the previous and new image identity. To stop the lane without deleting its isolated data, run:

```sh
export PAPERCLIP_STAGING_SECRET_DIR=/run/occ-paperclip-staging
./scripts/staging-paperclip-teardown.sh
```

Set `PAPERCLIP_STAGING_DELETE_DATA=true` only when the staging database and runtime volume must be deleted. This action cannot affect production volumes because the script names the two staging volumes exactly.
