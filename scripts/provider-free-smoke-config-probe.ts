import { loadConfig } from "../server/src/config.ts";

const config = loadConfig();
if (config.databaseUrl !== undefined || config.databaseMigrationUrl !== undefined) {
  throw new Error("provider-free config selected an external database binding");
}
if (config.databaseMode !== "embedded-postgres") {
  throw new Error(`provider-free config selected unexpected database mode: ${config.databaseMode}`);
}
