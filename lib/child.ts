import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionToolContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const GIT_OUTPUT_CAP = 200 * 1024;

const GIT_BASE_ARGV = ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.external="] as const;

const AWS_DIR = path.join(os.homedir(), ".aws");
const GITHUB_ROOT = path.join(os.homedir(), "github");

const RECURSIVE_TOOLS = new Set(["grep", "find", "ls"]);

function expandPath(input: string, cwd: string): string {
	const expanded = input === "~" || input.startsWith("~/") ? path.join(os.homedir(), input.slice(1)) : input;
	return path.normalize(path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded));
}

// Writes may target files that do not exist yet, so unresolved paths fall back
// to the nearest existing ancestor's real path while keeping the missing tail.
async function resolveReal(abs: string): Promise<string> {
	try {
		return await fs.promises.realpath(abs);
	} catch {
		const parent = path.dirname(abs);
		if (parent === abs) return abs;
		return path.join(await resolveReal(parent), path.basename(abs));
	}
}

function isWithin(resolved: string, dir: string): boolean {
	return resolved === dir || resolved.startsWith(dir + path.sep);
}

async function blockedPath(target: string, cwd: string, recursive: boolean): Promise<string | undefined> {
	const absolute = expandPath(target, cwd);
	const [resolved, awsRoot, githubRoot] = await Promise.all([
		resolveReal(absolute), resolveReal(AWS_DIR), resolveReal(GITHUB_ROOT),
	]);
	if (isWithin(absolute, AWS_DIR) || isWithin(resolved, awsRoot)) return "Access to ~/.aws is blocked.";
	if (recursive && (absolute === GITHUB_ROOT || resolved === githubRoot)) {
		return "Listing or searching ~/github itself is blocked. Use a project subdirectory.";
	}
}

const truncationSuffix = (dropped: number): string => `\n\n[Truncated: ${dropped} more characters.]`;

function appendTruncationNotice(text: string, dropped: number): string {
	return dropped > 0 ? `${text}${truncationSuffix(dropped)}` : text;
}

function capText(text: string, cap: number): string {
	if (text.length <= cap) return text;
	return `${text.slice(0, cap)}${truncationSuffix(text.length - cap)}`;
}

const GitAction = StringEnum(["status", "diff", "log"] as const, {
	description: "Read-only git view to show",
});

const GitParams = Type.Object({
	action: GitAction,
	cwd: Type.Optional(Type.String({ description: "Repository directory (default: current working directory)" })),
});

interface GitDetails {
	action: "status" | "diff" | "log";
	cwd: string;
	exitCode: number;
}

function gitActionArgv(action: GitDetails["action"]): string[] {
	switch (action) {
		case "status":
			return ["status", "--short"];
		case "diff":
			return ["diff", "HEAD", "--no-ext-diff", "--no-textconv"];
		case "log":
			return ["log", "-10", "--oneline"];
	}
}

interface GitRun {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function spawnGit(cwd: string, argv: readonly string[], signal: AbortSignal | undefined): Promise<GitRun> {
	if (signal?.aborted) return Promise.reject(new Error("Git operation aborted."));
	return new Promise((resolve) => {
		const child = spawn("git", argv, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, GIT_PAGER: "cat" },
		});

		let stdout = "";
		let stderr = "";
		let stdoutDropped = 0;
		let stderrDropped = 0;
		let settled = false;
		const abortListener = () => child.kill("SIGTERM");
		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abortListener);
			resolve({
				exitCode,
				stdout: appendTruncationNotice(stdout, stdoutDropped),
				stderr: appendTruncationNotice(stderr, stderrDropped),
			});
		};

		signal?.addEventListener("abort", abortListener, { once: true });
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");

		child.stdout?.on("data", (chunk: string) => {
			const keep = Math.min(chunk.length, Math.max(0, GIT_OUTPUT_CAP - stdout.length));
			stdout += chunk.slice(0, keep);
			stdoutDropped += chunk.length - keep;
		});
		child.stderr?.on("data", (chunk: string) => {
			const keep = Math.min(chunk.length, Math.max(0, GIT_OUTPUT_CAP - stderr.length));
			stderr += chunk.slice(0, keep);
			stderrDropped += chunk.length - keep;
		});
		child.on("close", (code) => finish(code ?? 1));
		child.on("error", () => finish(1));
	});
}

async function runGit(
	action: GitDetails["action"],
	cwdInput: string | undefined,
	ctx: ExtensionToolContext,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GitDetails>> {
	const target = cwdInput ?? ctx.cwd;
	const blocked = await blockedPath(target, ctx.cwd, false);
	if (blocked) throw new Error(blocked);
	const resolvedCwd = await resolveReal(expandPath(target, ctx.cwd));

	let run: GitRun;
	if (action === "diff") {
		run = await spawnGit(resolvedCwd, [...GIT_BASE_ARGV, ...gitActionArgv("diff")], signal);
		// Without HEAD, the index and working tree need separate comparisons.
		if (run.exitCode !== 0 && !signal?.aborted && /ambiguous argument 'HEAD'|bad revision 'HEAD'/.test(run.stderr)) {
			const staged = await spawnGit(resolvedCwd, [...GIT_BASE_ARGV, "diff", "--cached", "--no-ext-diff", "--no-textconv"], signal);
			if (staged.exitCode !== 0) run = staged;
			else {
				const unstaged = await spawnGit(resolvedCwd, [...GIT_BASE_ARGV, "diff", "--no-ext-diff", "--no-textconv"], signal);
				run = unstaged.exitCode !== 0 ? unstaged : { ...unstaged, stdout: capText(staged.stdout + unstaged.stdout, GIT_OUTPUT_CAP) };
			}
		}
	} else {
		run = await spawnGit(resolvedCwd, [...GIT_BASE_ARGV, ...gitActionArgv(action)], signal);
	}

	if (signal?.aborted) throw new Error("Git operation aborted.");
	if (run.exitCode !== 0) {
		throw new Error(`git ${action} failed (exit code ${run.exitCode}).\n${run.stderr || "(no stderr)"}`);
	}

	return {
		content: [{ type: "text", text: run.stdout || "(no changes)" }],
		details: { action, cwd: resolvedCwd, exitCode: run.exitCode },
	};
}

function registerGitTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "git",
		label: "Git",
		description:
			"Read-only git view. Shows repository status, the combined staged and unstaged diff, or recent commits. Arbitrary git arguments are not supported.",
		parameters: GitParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return runGit(params.action, params.cwd, ctx, signal);
		},
	});
}

export function registerPathGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		const input = event.input as { path?: string; cwd?: string };
		let target: string | undefined;
		if (RECURSIVE_TOOLS.has(event.toolName)) {
			target = input.path ?? ctx.cwd;
		} else if (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit" || event.toolName === "git") {
			target = input.path ?? input.cwd ?? ctx.cwd;
		}
		if (target === undefined) return undefined;

		const reason = await blockedPath(target, ctx.cwd, RECURSIVE_TOOLS.has(event.toolName));
		if (reason) return { block: true, reason };
		return undefined;
	});
}

export default function (pi: ExtensionAPI) {
	registerPathGuard(pi);
	registerGitTool(pi);
}
