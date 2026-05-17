import { conflict } from "../errors.js";

const NON_INVOCABLE_AGENT_STATUSES = new Set(["paused", "terminated", "pending_approval"]);

function hasConcreteBlockerComment(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0;
}

export function assertIssueAssigneeExecutableState(input: {
  status: string;
  assigneeAgentId: string | null;
  assigneeStatus: string | null;
  blockerComment?: string | null;
}) {
  if (!input.assigneeAgentId || !input.assigneeStatus || !NON_INVOCABLE_AGENT_STATUSES.has(input.assigneeStatus)) {
    return;
  }
  if (input.status === "blocked" && hasConcreteBlockerComment(input.blockerComment)) return;
  throw conflict(`Cannot assign ${input.status} work to ${input.assigneeStatus} agents`);
}
