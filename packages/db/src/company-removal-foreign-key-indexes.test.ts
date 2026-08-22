import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "./schema/index.js";

const removalParents = new Set([
  "issues",
  "documents",
  "execution_workspaces",
  "heartbeat_runs",
  "agent_wakeup_requests",
]);
const highVolumeAgentChildren = new Set([
  "activity_log",
  "agent_config_revisions",
  "agent_task_sessions",
  "cost_events",
  "document_revisions",
  "documents",
  "heartbeat_run_events",
  "issue_comments",
  "issue_recovery_actions",
  "issue_relations",
  "issues",
]);

describe("company removal foreign-key indexes", () => {
  it("indexes every reference to high-cardinality removal parents", () => {
    const seen = new Set<string>();
    const missing: string[] = [];
    let checked = 0;

    for (const value of Object.values(schema)) {
      let config: ReturnType<typeof getTableConfig>;
      try {
        config = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
      } catch {
        continue;
      }
      if (seen.has(config.name)) continue;
      seen.add(config.name);

      const candidates = config.indexes
        .filter((index) => !index.config.where)
        .map((index) => index.config.columns.map((column) => "name" in column ? column.name : ""))
        .filter((columns) => columns.every(Boolean));
      candidates.push(...config.uniqueConstraints.map((constraint) =>
        constraint.columns.map((column) => column.name)
      ));
      candidates.push(...config.primaryKeys.map((primaryKey) =>
        primaryKey.columns.map((column) => column.name)
      ));
      candidates.push(...config.columns
        .filter((column) => column.primary || column.isUnique)
        .map((column) => [column.name]));

      for (const foreignKey of config.foreignKeys) {
        const reference = foreignKey.reference();
        const parent = (reference.foreignTable as unknown as Record<symbol, string>)[Symbol.for("drizzle:Name")];
        if (!removalParents.has(parent) && !(parent === "agents" && highVolumeAgentChildren.has(config.name))) {
          continue;
        }
        checked += 1;
        const columns = reference.columns.map((column) => column.name);
        if (!candidates.some((candidate) =>
          columns.every((column, index) => candidate[index] === column)
        )) {
          missing.push(`${config.name}(${columns.join(",")}) -> ${parent}`);
        }
      }
    }

    expect(checked).toBeGreaterThan(90);
    expect(missing).toEqual([]);
  });
});
