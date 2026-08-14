import assert from "node:assert/strict";
import { it } from "vitest";
import { evaluateRuntimeCommandGuard } from "./runtime-command-guard.js";

const blockedCases = [
  ["env", "env"],
  ["printenv", "printenv"],
  ["set", "set"],
  ["bash -lc 'env'", "env"],
  ["bash -lc 'printenv'", "printenv"],
  ["bash -lc 'set'", "set"],
  ["bash '-lc' 'set'", "set"],
  ["bash -lc 'printf ok; env'", "env"],
  ["bash -lc 'printf ok && printenv'", "printenv"],
  ["bash -lc 'printf ok | set'", "set"],
  ["env >/dev/null", "env"],
  ["printenv >/dev/null", "printenv"],
  ["bash -lc 'set >/dev/null'", "set"],
  ["'env'", "env"],
  ["env FOO=bar", "env"],
  ["env FOO=bar bash -lc 'set'", "set"],
] as const;

const allowedCases = [
  "rg 'env|printenv|set' packages/adapters",
  "rg 'env; printenv && set' packages/adapters",
  'grep -R "env printenv set" packages/adapters',
  `bash -lc "rg -n \\"function readRuntimeGuardCommand|evaluateRuntimeCommandGuard|rg 'env|printenv|set'\\" packages/adapters -S"`,
  "set -eu",
  "printenv HOME",
  "env FOO=bar sh -c 'printf ok'",
] as const;

it("blocks broad dump commands while allowing quoted search patterns", () => {
  for (const [command, sanitizedPattern] of blockedCases) {
    const decision = evaluateRuntimeCommandGuard(command);
    assert.equal(decision.allowed, false, command);
    assert.equal(decision.code, "runtime_command_guard_broad_dump");
    assert.equal(decision.redactedCommand, command);
    assert.equal(decision.message.includes(sanitizedPattern), true);
  }

  for (const command of allowedCases) {
    assert.deepEqual(evaluateRuntimeCommandGuard(command), { allowed: true });
  }
});
