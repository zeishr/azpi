import type { ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import { extname, isAbsolute, relative, resolve } from "node:path";

/**
 * Turns Pi tool calls into what an ACP client displays: a title, an icon
 * category, the files involved, and the content of the tool card.
 *
 * Live events and replayed sessions both go through here, so a reopened
 * conversation looks like it did while it ran.
 */

export interface PresentationContext {
  /** Session working directory, used to resolve relative paths and shorten titles. */
  cwd: string;
  /** False when rebuilding a stored session: the terminals it used are gone. */
  live: boolean;
}

/** A tool result as Pi produces it, live (AgentToolResult) or stored (ToolResultMessage). */
export interface ToolOutcome {
  content?: unknown;
  details?: unknown;
  isError: boolean;
}

export interface ToolCallView {
  title: string;
  kind: ToolKind;
  locations: ToolCallLocation[];
  content: ToolCallContent[];
}

type Args = Record<string, unknown>;

/**
 * How one tool is shown. Content hooks return undefined to leave the card's
 * current content untouched: ACP replaces the whole content list on update.
 */
interface ToolPresenter {
  kind: ToolKind;
  title(args: Args, ctx: PresentationContext): string;
  locations?(args: Args, ctx: PresentationContext): ToolCallLocation[];
  /** Content shown from the start, before any output, such as a proposed edit. */
  preview?(args: Args, ctx: PresentationContext): ToolCallContent[];
  progress?(
    args: Args,
    partial: ToolOutcome,
    ctx: PresentationContext,
  ): ToolCallContent[] | undefined;
  result?(
    args: Args,
    outcome: ToolOutcome,
    ctx: PresentationContext,
  ): ToolCallContent[] | undefined;
}

const MAX_TITLE_LENGTH = 120;

/** Argument keys worth showing in the title of a tool AZPi knows nothing about. */
const SUMMARY_KEYS = ["path", "file", "url", "query", "command", "pattern", "agent", "name", "id"];

const PRESENTERS: Record<string, ToolPresenter> = {
  read: {
    kind: "read",
    title: (args, ctx) => `Read ${displayPath(args.path, ctx)}${lineRange(args)}`,
    locations: (args, ctx) => fileLocation(args.path, ctx, numberArg(args.offset)),
    result: (args, outcome) =>
      outcome.isError ? undefined : codeContent(outcome, languageOf(args.path)),
  },
  write: {
    kind: "edit",
    title: (args, ctx) => `Write ${displayPath(args.path, ctx)}`,
    locations: (args, ctx) => fileLocation(args.path, ctx),
    preview: (args, ctx) => writeDiff(args, ctx),
    // On success the preview diff already shows what was written.
    result: (_args, outcome) => (outcome.isError ? textContent(outcome) : undefined),
  },
  edit: {
    kind: "edit",
    title: (args, ctx) => `Edit ${displayPath(args.path, ctx)}`,
    locations: (args, ctx) => fileLocation(args.path, ctx),
    preview: (args, ctx) => editDiffs(args, ctx),
    result: (_args, outcome) => (outcome.isError ? textContent(outcome) : undefined),
  },
  bash: {
    kind: "execute",
    title: (args) => inlineCode(firstLine(stringArg(args.command) ?? "")),
    progress: (_args, partial, ctx) => shellOutput(partial, ctx),
    result: (_args, outcome, ctx) => shellOutput(outcome, ctx),
  },
  grep: {
    kind: "search",
    title: (args, ctx) =>
      `Grep ${inlineCode(stringArg(args.pattern) ?? "")} in ${displayPath(args.path ?? ".", ctx)}` +
      (stringArg(args.glob) ? ` (${args.glob})` : ""),
    result: (_args, outcome) => (outcome.isError ? undefined : codeContent(outcome, "")),
  },
  find: {
    kind: "search",
    title: (args, ctx) =>
      `Find ${inlineCode(stringArg(args.pattern) ?? "")} in ${displayPath(args.path ?? ".", ctx)}`,
    result: (_args, outcome) => (outcome.isError ? undefined : codeContent(outcome, "")),
  },
  ls: {
    kind: "search",
    title: (args, ctx) => `List ${displayPath(args.path ?? ".", ctx)}`,
    result: (_args, outcome) => (outcome.isError ? undefined : codeContent(outcome, "")),
  },
  web_search: {
    kind: "search",
    title: (args) => `Web search: ${listArg(args.queries ?? args.query).join(" | ")}`,
  },
  fetch_content: {
    kind: "fetch",
    title: (args) => `Fetch ${listArg(args.urls ?? args.url).join(", ")}`,
  },
};

const GENERIC_PRESENTER: ToolPresenter = {
  kind: "other",
  title: () => "",
  // Unknown tools have no better summary than their arguments.
  preview: (args) => (Object.keys(args).length > 0 ? [codeBlock(safeJson(args), "json")] : []),
};

export function presentToolCall(
  name: string,
  rawArgs: unknown,
  ctx: PresentationContext,
): ToolCallView {
  const args = asArgs(rawArgs);
  const presenter = presenterFor(name);
  const title =
    presenter === GENERIC_PRESENTER ? genericTitle(name, args) : presenter.title(args, ctx);
  return {
    title: truncate(title || name),
    kind: presenter.kind,
    locations: presenter.locations?.(args, ctx) ?? [],
    content: presenter.preview?.(args, ctx) ?? [],
  };
}

export function presentToolProgress(
  name: string,
  rawArgs: unknown,
  partial: ToolOutcome,
  ctx: PresentationContext,
): ToolCallContent[] | undefined {
  const presenter = presenterFor(name);
  if (presenter.progress) return presenter.progress(asArgs(rawArgs), partial, ctx);
  return textContent(partial);
}

export function presentToolResult(
  name: string,
  rawArgs: unknown,
  outcome: ToolOutcome,
  ctx: PresentationContext,
): ToolCallContent[] | undefined {
  const presenter = presenterFor(name);
  if (presenter.result) {
    const content = presenter.result(asArgs(rawArgs), outcome, ctx);
    // A presenter that declines an error still has to surface the message.
    return content ?? (outcome.isError ? textContent(outcome) : undefined);
  }
  return resultBlocks(outcome);
}

/** Locations known only once the tool ran, such as the first line an edit changed. */
export function presentResultLocations(
  name: string,
  rawArgs: unknown,
  outcome: ToolOutcome,
  ctx: PresentationContext,
): ToolCallLocation[] | undefined {
  if (name !== "edit" || outcome.isError) return undefined;
  const line = firstChangedLine(outcome.details);
  return line === undefined ? undefined : fileLocation(asArgs(rawArgs).path, ctx, line);
}

function presenterFor(name: string): ToolPresenter {
  return PRESENTERS[name] ?? GENERIC_PRESENTER;
}

function genericTitle(name: string, args: Args): string {
  const key = SUMMARY_KEYS.find((candidate) => stringArg(args[candidate]));
  return key ? `${name}: ${firstLine(stringArg(args[key])!)}` : name;
}

/**
 * A bash card backed by an ACP terminal shows that terminal, which the client
 * streams on its own. Its content must not be resent: once released, the
 * terminal id is unknown to the client, which then rejects the whole update.
 */
function shellOutput(
  outcome: ToolOutcome,
  ctx: PresentationContext,
): ToolCallContent[] | undefined {
  if (terminalIdOf(outcome.details)) {
    return ctx.live ? undefined : codeContent(outcome, "console");
  }
  return codeContent(outcome, "console");
}

export function terminalIdOf(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const id = (details as Record<string, unknown>).terminalId;
  return typeof id === "string" ? id : undefined;
}

function editDiffs(args: Args, ctx: PresentationContext): ToolCallContent[] {
  const path = absolutePath(args.path, ctx);
  if (!path) return [];
  return editsOf(args).map(({ oldText, newText }) => ({ type: "diff", path, oldText, newText }));
}

/** Pi accepts both `edits: [...]` and a single legacy top-level oldText/newText pair. */
function editsOf(args: Args): Array<{ oldText: string; newText: string }> {
  const edits = Array.isArray(args.edits) ? args.edits : [args];
  return edits.flatMap((edit) => {
    const oldText = stringArg(edit?.oldText);
    const newText = stringArg(edit?.newText);
    return oldText !== undefined && newText !== undefined ? [{ oldText, newText }] : [];
  });
}

function writeDiff(args: Args, ctx: PresentationContext): ToolCallContent[] {
  const path = absolutePath(args.path, ctx);
  const newText = stringArg(args.content);
  // Without the previous content, the write shows as a whole new file.
  return path && newText !== undefined ? [{ type: "diff", path, oldText: null, newText }] : [];
}

function firstChangedLine(details: unknown): number | undefined {
  if (!details || typeof details !== "object") return undefined;
  return numberArg((details as Record<string, unknown>).firstChangedLine);
}

function lineRange(args: Args): string {
  const offset = numberArg(args.offset);
  const limit = numberArg(args.limit);
  if (offset !== undefined && limit !== undefined) return ` (L${offset}-${offset + limit - 1})`;
  if (offset !== undefined) return ` (from L${offset})`;
  if (limit !== undefined) return ` (L1-${limit})`;
  return "";
}

function fileLocation(path: unknown, ctx: PresentationContext, line?: number): ToolCallLocation[] {
  const absolute = absolutePath(path, ctx);
  if (!absolute) return [];
  return [line === undefined ? { path: absolute } : { path: absolute, line }];
}

function absolutePath(path: unknown, ctx: PresentationContext): string | undefined {
  const value = stringArg(path);
  if (!value) return undefined;
  return isAbsolute(value) ? value : resolve(ctx.cwd, value);
}

/** Paths inside the working directory read better relative to it. */
function displayPath(path: unknown, ctx: PresentationContext): string {
  const absolute = absolutePath(path, ctx);
  if (!absolute) return "";
  const fromCwd = relative(ctx.cwd, absolute);
  if (fromCwd === "") return ".";
  return fromCwd.startsWith("..") || isAbsolute(fromCwd) ? absolute : fromCwd;
}

/** The file extension doubles as the info string that drives highlighting. */
function languageOf(path: unknown): string {
  return extname(stringArg(path) ?? "").slice(1);
}

function codeContent(outcome: ToolOutcome, language: string): ToolCallContent[] {
  const text = textOf(outcome.content);
  return [...(text ? [codeBlock(text, language)] : []), ...imageBlocks(outcome.content)];
}

function codeBlock(text: string, language: string): ToolCallContent {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return {
    type: "content",
    content: { type: "text", text: `${fence}${language}\n${text.replace(/\n$/, "")}\n${fence}` },
  };
}

function textContent(outcome: ToolOutcome): ToolCallContent[] {
  const text = textOf(outcome.content) || describeRaw(outcome.content);
  return text ? [{ type: "content", content: { type: "text", text } }] : [];
}

/** Shows a Pi result as is: its text, then its images. */
function resultBlocks(outcome: ToolOutcome): ToolCallContent[] {
  const blocks = [...textContent(outcome), ...imageBlocks(outcome.content)];
  return blocks;
}

function imageBlocks(content: unknown): ToolCallContent[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === "image" && typeof block.data === "string")
    .map((block) => ({
      type: "content",
      content: { type: "image", data: block.data, mimeType: block.mimeType ?? "image/png" },
    }));
}

/** Joins the text blocks of a Pi result, or returns a plain string result as is. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/** Last resort for results that are neither strings nor Pi content arrays. */
function describeRaw(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object" && typeof (value as Record<string, unknown>).error === "string") {
    return (value as Record<string, string>).error!;
  }
  return Array.isArray(value) && value.length === 0 ? "" : safeJson(value);
}

function inlineCode(text: string): string {
  const fence = "`".repeat(longestBacktickRun(text) + 1);
  // Markdown needs a space between the fence and content that touches a backtick.
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
}

function firstLine(text: string): string {
  const lines = text.trim().split("\n");
  return lines.length > 1 ? `${lines[0]} …` : (lines[0] ?? "");
}

function truncate(text: string): string {
  return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH - 1)}…` : text;
}

function asArgs(value: unknown): Args {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Args) : {};
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberArg(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // Models sometimes send numbers as strings; Pi accepts them too.
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function listArg(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, undefined, 2);
  } catch {
    return String(value);
  }
}
