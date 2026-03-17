/**
 * Handoff extension - generate context handoff and move it to a new session
 *
 * Usage:
 *   /handoff implement this for teams as well
 *   /handoff --draft investigate race conditions in the cache layer
 *   /handoff-save --path ~/tmp/handoff.md investigate branch-specific bug in auth middleware
 *   /handoff-load --delete-after-load
 *   /handoff-view --path ~/tmp/handoff.md
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@mariozechner/pi-coding-agent";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type RoleMessage = {
  role: "user" | "assistant";
  content: unknown;
};

type AssistantRoleMessage = RoleMessage & {
  role: "assistant";
  stopReason?: unknown;
};

const HANDOFF_TIMEOUT_MS = 5 * 60 * 1000;
const HANDOFF_POLL_INTERVAL_MS = 25;
const HANDOFF_DRAFT_FLAG = "--draft";
const HANDOFF_WRITE_FLAG = "--write";
const HANDOFF_PATH_FLAG = "--path";
const HANDOFF_LOAD_VIEW_FLAG = "--view";
const HANDOFF_DELETE_AFTER_LOAD_FLAG = "--delete-after-load";
const DEFAULT_HANDOFF_FILE = "~/.pi/handoff/latest.md";

const HANDOFF_INSTRUCTIONS = `You are writing a handoff note for another AI agent with NO access to this chat.

Extract only task-relevant context from this conversation.

Rules:
- Be tight and token-efficient.
- Use only concrete facts from this conversation.
- Prefer specifics: file paths, symbols, commands, errors, outputs, decisions.
- Include constraints/invariants only when explicit, non-negotiable, and task-relevant.
- Include line numbers only if known from this conversation.
- Omit irrelevant history and broad retrospectives.
- Do not invent missing details.
- If a critical detail is unknown, say so briefly and include the smallest verification step.
- Do not write a plan unless one already exists in this conversation.
- Do not call tools.

Output:
- Markdown only.
- Handoff context only (do not restate the task).`;

type NotifyFn = (message: string, level: "info" | "warning" | "error") => void;

type ParseResult<T> = { value: T } | { error: string };

type ParsedPathOption = {
  path: string;
  rest: string[];
};

type ParsedHandoffArgs = {
  task: string;
  draftOnly: boolean;
};

type ParsedHandoffSaveArgs = {
  task: string;
  path: string;
};

type ParsedHandoffLoadArgs = {
  path: string;
  viewOnly: boolean;
  deleteAfterLoad: boolean;
};

type HandoffTurn = {
  branch: SessionEntry[];
  handoffUserIndex: number;
};

function getRoleMessage(entry: SessionEntry, role: "user" | "assistant"): RoleMessage | null {
  if (entry.type !== "message" || !isRecord(entry.message)) {
    return null;
  }

  const message = entry.message;
  if (message.role !== role || !("content" in message)) {
    return null;
  }

  return message as RoleMessage;
}

function getAssistantMessage(entry: SessionEntry): AssistantRoleMessage | null {
  const message = getRoleMessage(entry, "assistant");
  if (!message || !isRecord(message)) {
    return null;
  }

  return message as AssistantRoleMessage;
}

function getMessageText(entry: SessionEntry): string {
  if (entry.type !== "message" || !isRecord(entry.message) || !("content" in entry.message)) {
    return "";
  }

  const content = entry.message.content;
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((block): block is { type: "text"; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function splitArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter((token) => token.length > 0);
}

function parsePathOption(tokens: string[], defaultPath: string): ParseResult<ParsedPathOption> {
  const rest: string[] = [];
  let path = defaultPath;
  let pathSpecified = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === HANDOFF_PATH_FLAG) {
      if (pathSpecified) {
        return { error: `Duplicate ${HANDOFF_PATH_FLAG} flag.` };
      }

      const nextToken = tokens[i + 1];
      if (!nextToken || nextToken.startsWith("--")) {
        return { error: `Missing value for ${HANDOFF_PATH_FLAG}.` };
      }

      path = nextToken;
      pathSpecified = true;
      i++;
      continue;
    }

    if (token.startsWith(`${HANDOFF_PATH_FLAG}=`)) {
      if (pathSpecified) {
        return { error: `Duplicate ${HANDOFF_PATH_FLAG} flag.` };
      }

      const value = token.slice(`${HANDOFF_PATH_FLAG}=`.length).trim();
      if (!value) {
        return { error: `Missing value for ${HANDOFF_PATH_FLAG}.` };
      }

      path = value;
      pathSpecified = true;
      continue;
    }

    rest.push(token);
  }

  return {
    value: {
      path,
      rest,
    },
  };
}

function parseHandoffArgs(args: string): ParseResult<ParsedHandoffArgs> {
  const tokens = splitArgs(args);
  const taskTokens: string[] = [];

  let draftOnly = false;

  for (const token of tokens) {
    if (token === HANDOFF_DRAFT_FLAG) {
      draftOnly = true;
      continue;
    }

    if (token === HANDOFF_WRITE_FLAG || token.startsWith(`${HANDOFF_WRITE_FLAG}=`)) {
      return {
        error: `${HANDOFF_WRITE_FLAG} moved to /handoff-save. Use: /handoff-save [--path <path>] <task>`,
      };
    }

    taskTokens.push(token);
  }

  const task = taskTokens.join(" ").trim();
  if (!task) {
    return {
      error: "Usage: /handoff [--draft] <goal or task for next thread>",
    };
  }

  return {
    value: {
      task,
      draftOnly,
    },
  };
}

function parseHandoffSaveArgs(args: string): ParseResult<ParsedHandoffSaveArgs> {
  const pathResult = parsePathOption(splitArgs(args), DEFAULT_HANDOFF_FILE);
  if ("error" in pathResult) {
    return pathResult;
  }

  const unknownFlag = pathResult.value.rest.find((token) => token.startsWith("--"));
  if (unknownFlag) {
    return {
      error: `Unknown flag: ${unknownFlag}. Usage: /handoff-save [--path <path>] <task>`,
    };
  }

  const task = pathResult.value.rest.join(" ").trim();
  if (!task) {
    return {
      error: "Usage: /handoff-save [--path <path>] <goal or task for next thread>",
    };
  }

  return {
    value: {
      task,
      path: pathResult.value.path,
    },
  };
}

function parseHandoffLoadArgs(args: string): ParseResult<ParsedHandoffLoadArgs> {
  const tokens = splitArgs(args);
  const pathTokens: string[] = [];
  let viewOnly = false;
  let deleteAfterLoad = false;

  for (const token of tokens) {
    if (token === HANDOFF_LOAD_VIEW_FLAG) {
      viewOnly = true;
      continue;
    }

    if (token === HANDOFF_DELETE_AFTER_LOAD_FLAG) {
      deleteAfterLoad = true;
      continue;
    }

    pathTokens.push(token);
  }

  if (viewOnly && deleteAfterLoad) {
    return {
      error: `Cannot combine ${HANDOFF_LOAD_VIEW_FLAG} with ${HANDOFF_DELETE_AFTER_LOAD_FLAG}.`,
    };
  }

  const pathResult = parsePathOption(pathTokens, DEFAULT_HANDOFF_FILE);
  if ("error" in pathResult) {
    return pathResult;
  }

  if (pathResult.value.rest.length > 0) {
    return {
      error: `Unexpected arguments: ${pathResult.value.rest.join(" ")}. Use ${HANDOFF_PATH_FLAG} for custom files.`,
    };
  }

  return {
    value: {
      path: pathResult.value.path,
      viewOnly,
      deleteAfterLoad,
    },
  };
}

function parseHandoffViewArgs(args: string): ParseResult<{ path: string }> {
  const pathResult = parsePathOption(splitArgs(args), DEFAULT_HANDOFF_FILE);
  if ("error" in pathResult) {
    return pathResult;
  }

  if (pathResult.value.rest.length > 0) {
    return {
      error: `Unexpected arguments: ${pathResult.value.rest.join(" ")}. Usage: /handoff-view [--path <path>]`,
    };
  }

  return {
    value: {
      path: pathResult.value.path,
    },
  };
}

function resolveHandoffPath(inputPath: string, cwd: string): string {
  if (inputPath === "~") {
    return homedir();
  }

  if (inputPath.startsWith("~/")) {
    return resolve(homedir(), inputPath.slice(2));
  }

  if (isAbsolute(inputPath)) {
    return inputPath;
  }

  return resolve(cwd, inputPath);
}

async function writeHandoffFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function readHandoffFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

async function deleteHandoffFile(filePath: string): Promise<void> {
  await unlink(filePath);
}

async function waitForHandoffTurn(
  ctx: ExtensionCommandContext,
  startIndex: number,
  handoffRequest: string,
  timeoutMs = HANDOFF_TIMEOUT_MS,
): Promise<HandoffTurn | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const branch = ctx.sessionManager.getBranch();
    const handoffUserIndex = findUserMessageIndex(branch, startIndex, handoffRequest);

    if (handoffUserIndex !== -1 && hasAssistantAfterIndex(branch, handoffUserIndex) && ctx.isIdle()) {
      return {
        branch,
        handoffUserIndex,
      };
    }

    await new Promise<void>((resolve) => setTimeout(resolve, HANDOFF_POLL_INTERVAL_MS));
  }

  return null;
}

function findUserMessageIndex(entries: SessionEntry[], fromIndex: number, text: string): number {
  for (let i = entries.length - 1; i >= fromIndex; i--) {
    const entry = entries[i];
    if (!getRoleMessage(entry, "user")) {
      continue;
    }

    if (getMessageText(entry) === text) {
      return i;
    }
  }

  return -1;
}

function hasAssistantAfterIndex(entries: SessionEntry[], fromIndex: number): boolean {
  for (let i = entries.length - 1; i > fromIndex; i--) {
    const entry = entries[i];
    if (getRoleMessage(entry, "assistant")) {
      return true;
    }
  }

  return false;
}

function getAssistantText(entries: SessionEntry[], fromIndex: number): string | null {
  for (let i = entries.length - 1; i >= fromIndex; i--) {
    const entry = entries[i];
    const message = getAssistantMessage(entry);
    if (!message) {
      continue;
    }

    if (message.stopReason !== "stop") {
      return null;
    }

    const text = getMessageText(entry);
    if (text.length > 0) {
      return text;
    }
  }

  return null;
}

async function generateHandoffPrompt(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  task: string,
  notify: NotifyFn,
): Promise<string | null> {
  const startIndex = ctx.sessionManager.getBranch().length;
  const handoffRequest = `${HANDOFF_INSTRUCTIONS}\n\nTask for the next agent:\n${task}`;

  if (ctx.isIdle()) {
    pi.sendUserMessage(handoffRequest);
  } else {
    pi.sendUserMessage(handoffRequest, { deliverAs: "followUp" });
  }

  notify("Generating handoff note...", "info");
  const handoffTurn = await waitForHandoffTurn(ctx, startIndex, handoffRequest);

  if (!handoffTurn) {
    notify("Timed out waiting for handoff note", "error");
    return null;
  }

  const handoffNote = getAssistantText(handoffTurn.branch, handoffTurn.handoffUserIndex + 1);
  if (!handoffNote) {
    notify("Failed to capture handoff note from the assistant response", "error");
    return null;
  }

  return `${handoffNote}\n\n---\n\n## Task\n${task}`;
}

export default function(pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Transfer context to a new focused session (or draft to editor)",
    handler: async (args, ctx) => {
      const notify: NotifyFn = (message, level) => {
        ctx.ui?.notify?.(message, level);
      };

      if (!ctx.model) {
        notify("No model selected", "error");
        return;
      }

      const parsed = parseHandoffArgs(args);
      if ("error" in parsed) {
        notify(parsed.error, "error");
        return;
      }

      const currentSessionFile = ctx.sessionManager.getSessionFile();
      const promptForNewSession = await generateHandoffPrompt(pi, ctx, parsed.value.task, notify);
      if (!promptForNewSession) {
        return;
      }

      if (parsed.value.draftOnly) {
        if (!ctx.ui) {
          notify("Draft mode requires interactive UI. Use /handoff-save to write a file.", "error");
          return;
        }

        ctx.ui.setEditorText(promptForNewSession);
        notify("Handoff prompt drafted in editor.", "info");
        return;
      }

      const newSessionResult = await ctx.newSession({
        parentSession: currentSessionFile,
        withSession: async (newSessionCtx) => {
          if (newSessionCtx.isIdle()) {
            await newSessionCtx.sendUserMessage(promptForNewSession);
          } else {
            await newSessionCtx.sendUserMessage(promptForNewSession, { deliverAs: "followUp" });
          }

          newSessionCtx.ui?.notify?.("Handoff sent to the new session.", "info");
        },
      });

      if (newSessionResult.cancelled) {
        notify("New session cancelled", "info");
      }
    },
  });

  pi.registerCommand("handoff-save", {
    description: "Generate a handoff prompt and save it to a file",
    handler: async (args, ctx) => {
      const notify: NotifyFn = (message, level) => {
        ctx.ui?.notify?.(message, level);
      };

      if (!ctx.model) {
        notify("No model selected", "error");
        return;
      }

      const parsed = parseHandoffSaveArgs(args);
      if ("error" in parsed) {
        notify(parsed.error, "error");
        return;
      }

      const handoffPrompt = await generateHandoffPrompt(pi, ctx, parsed.value.task, notify);
      if (!handoffPrompt) {
        return;
      }

      const filePath = resolveHandoffPath(parsed.value.path, ctx.cwd);
      try {
        await writeHandoffFile(filePath, handoffPrompt);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify(`Failed to write handoff file: ${message}`, "error");
        return;
      }

      notify(`Handoff saved to ${filePath}`, "info");
    },
  });

  pi.registerCommand("handoff-load", {
    description: "Load a saved handoff prompt (supports --path, --view, --delete-after-load)",
    handler: async (args, ctx) => {
      const notify: NotifyFn = (message, level) => {
        ctx.ui?.notify?.(message, level);
      };

      const parsed = parseHandoffLoadArgs(args);
      if ("error" in parsed) {
        notify(parsed.error, "error");
        return;
      }

      const filePath = resolveHandoffPath(parsed.value.path, ctx.cwd);

      let handoffPrompt = "";
      try {
        handoffPrompt = (await readHandoffFile(filePath)).trim();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify(`Failed to read handoff file ${filePath}: ${message}`, "error");
        return;
      }

      if (!handoffPrompt) {
        notify(`Handoff file is empty: ${filePath}`, "error");
        return;
      }

      if (parsed.value.viewOnly) {
        if (!ctx.ui) {
          notify("/handoff-load --view requires interactive UI", "error");
          return;
        }

        ctx.ui.setEditorText(handoffPrompt);
        notify(`Handoff loaded into editor from ${filePath}`, "info");
        return;
      }

      if (ctx.isIdle()) {
        pi.sendUserMessage(handoffPrompt);
      } else {
        pi.sendUserMessage(handoffPrompt, { deliverAs: "followUp" });
      }

      if (parsed.value.deleteAfterLoad) {
        try {
          await deleteHandoffFile(filePath);
          notify(`Loaded handoff and deleted ${filePath}`, "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          notify(`Loaded handoff, but failed to delete ${filePath}: ${message}`, "warning");
        }
        return;
      }

      notify(`Loaded handoff from ${filePath}`, "info");
    },
  });

  pi.registerCommand("handoff-view", {
    description: "View a saved handoff prompt in the editor without sending",
    handler: async (args, ctx) => {
      const notify: NotifyFn = (message, level) => {
        ctx.ui?.notify?.(message, level);
      };

      if (!ctx.ui) {
        notify("/handoff-view requires interactive UI", "error");
        return;
      }

      const parsed = parseHandoffViewArgs(args);
      if ("error" in parsed) {
        notify(parsed.error, "error");
        return;
      }

      const filePath = resolveHandoffPath(parsed.value.path, ctx.cwd);

      let handoffPrompt = "";
      try {
        handoffPrompt = (await readHandoffFile(filePath)).trim();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify(`Failed to read handoff file ${filePath}: ${message}`, "error");
        return;
      }

      if (!handoffPrompt) {
        notify(`Handoff file is empty: ${filePath}`, "error");
        return;
      }

      ctx.ui.setEditorText(handoffPrompt);
      notify(`Handoff loaded into editor from ${filePath}`, "info");
    },
  });
}
