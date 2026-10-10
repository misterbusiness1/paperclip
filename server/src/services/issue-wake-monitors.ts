import { and, eq, gt, inArray } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";

/** The scheduled monitor owns the assignee's next automatic check of this wait. */
export async function findFutureAssigneeWakeMonitor(
  db: Pick<Db, "select">,
  input: { companyId: string; issueId: string; agentId: string; now?: Date },
) {
  return db.select({ nextCheckAt: issues.monitorNextCheckAt }).from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.id, input.issueId),
      eq(issues.assigneeAgentId, input.agentId),
      inArray(issues.status, ["blocked", "in_review"]),
      gt(issues.monitorNextCheckAt, input.now ?? new Date()),
    )).limit(1).then(rows => rows[0] ?? null);
}
