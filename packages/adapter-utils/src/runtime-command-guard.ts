import { redactCommandText } from "./command-redaction.js";

export type RuntimeCommandGuardDecision =
  | { allowed: true }
  | { allowed: false; code: "runtime_command_guard_broad_dump"; message: string; redactedCommand: string };

const ASSIGNMENT_WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECTION_OPERATOR_RE = /^\d*(?:>>?|<<?|<>|>&|<&)$/;
const ATTACHED_REDIRECTION_RE = /^\d*(?:>>?|<<?|<>|>&|<&).+$/;

type ShellWord = {
  text: string;
  quoted: boolean;
};

function pathBasename(value: string): string {
  const cleaned = value.replace(/^['"]|['"]$/g, "");
  return cleaned.split(/[\/]/).pop() ?? cleaned;
}

function readShellSegments(command: string): ShellWord[][] {
  const segments: ShellWord[][] = [];
  let words: ShellWord[] = [];
  let current = "";
  let currentQuoted = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const pushWord = () => {
    if (!current) return;
    words.push({ text: current, quoted: currentQuoted });
    current = "";
    currentQuoted = false;
  };
  const pushSegment = () => {
    pushWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      currentQuoted = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      currentQuoted = true;
      continue;
    }
    if (/\s/.test(char) || char === "(" || char === ")") {
      pushWord();
      continue;
    }
    if (char === ";" || char === "&" || char === "|") {
      pushSegment();
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  pushSegment();
  return segments;
}

function stripLeadingAssignments(words: ShellWord[]): ShellWord[] {
  let idx = 0;
  while (idx < words.length && ASSIGNMENT_WORD_RE.test(words[idx]?.text ?? "")) idx += 1;
  return words.slice(idx);
}

function stripRedirections(words: ShellWord[]): ShellWord[] {
  const kept: ShellWord[] = [];
  for (let idx = 0; idx < words.length; idx += 1) {
    const text = words[idx]?.text ?? "";
    if (REDIRECTION_OPERATOR_RE.test(text)) {
      idx += 1;
      continue;
    }
    if (ATTACHED_REDIRECTION_RE.test(text)) continue;
    kept.push(words[idx]!);
  }
  return kept;
}

function envCommandWords(args: ShellWord[]): ShellWord[] {
  for (let idx = 0; idx < args.length; idx += 1) {
    const text = args[idx]?.text ?? "";
    if (text === "--") return args.slice(idx + 1);
    if (ASSIGNMENT_WORD_RE.test(text)) continue;
    if (["-u", "--unset", "-C", "--chdir", "-S", "--split-string"].includes(text)) {
      idx += 1;
      continue;
    }
    if (text.startsWith("-")) continue;
    return args.slice(idx);
  }
  return [];
}

function shellWordsToCommand(words: ShellWord[]): string {
  return words.map((word) => `'${word.text.replace(/'/g, `'"'"'`)}'`).join(" ");
}

function isBroadDumpInvocation(executable: string, args: ShellWord[]): boolean {
  if (executable === "set") return args.length === 0;
  if (executable === "printenv") {
    return !args.some((word) => word.text !== "--" && !word.text.startsWith("-"));
  }
  return executable === "env" && envCommandWords(args).length === 0;
}

function commandContainsBroadEnvironmentDump(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) return false;

  for (const segment of readShellSegments(normalized)) {
    const words = stripLeadingAssignments(segment);
    if (words.length === 0) continue;
    const executable = pathBasename(words[0]?.text ?? "");
    const args = stripRedirections(words.slice(1));
    if (isBroadDumpInvocation(executable, args)) return true;
    if (executable === "env") {
      const nestedCommand = envCommandWords(args);
      if (nestedCommand.length > 0 && commandContainsBroadEnvironmentDump(shellWordsToCommand(nestedCommand))) {
        return true;
      }
    }
    const shellFlagIndex = words.findIndex((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word.text));
    if ((executable === "sh" || executable === "bash" || executable === "zsh") && shellFlagIndex >= 0) {
      const shellCommand = words
        .slice(shellFlagIndex + 1)
        .map((word) => word.text)
        .join(" ");
      if (commandContainsBroadEnvironmentDump(shellCommand)) return true;
    }
  }

  return false;
}

export function evaluateRuntimeCommandGuard(command: string): RuntimeCommandGuardDecision {
  if (!commandContainsBroadEnvironmentDump(command)) return { allowed: true };
  const redactedCommand = redactCommandText(command);
  return {
    allowed: false,
    code: "runtime_command_guard_broad_dump",
    message: `runtime_command_guard_broad_dump: runtime command guard rejected a broad environment dump command before execution: ${redactedCommand}`,
    redactedCommand,
  };
}
