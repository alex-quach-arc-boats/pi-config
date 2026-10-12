import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(TEST_DIR);
const HARNESS_PATH = path.join(ROOT_DIR, "extensions", "harness.ts");
const CHILD_PATH = path.join(ROOT_DIR, "lib", "child.ts");
const GIT_OUTPUT_CAP = 200 * 1024;
const fixtureRoot = fs.mkdtempSync(path.join(TEST_DIR, ".fixture-"));
const HOME = path.join(fixtureRoot, "home");
const GITHUB_ROOT = path.join(HOME, "github");
const AWS_DIR = path.join(HOME, ".aws");

fs.mkdirSync(GITHUB_ROOT, { recursive: true });
fs.mkdirSync(AWS_DIR, { recursive: true });
const agentDir = path.join(fixtureRoot, "agent-dir");
fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
fs.writeFileSync(path.join(agentDir, "agents", "primary.md"), "PRIMARY TEST PROMPT");

const strippedSources = new Map([
	[HARNESS_PATH, stripTypeScriptTypes(fs.readFileSync(HARNESS_PATH, "utf8"))],
	[CHILD_PATH, stripTypeScriptTypes(fs.readFileSync(CHILD_PATH, "utf8"))],
]);

const stubModules = new Map([
	["node:os", { homedir: () => HOME }],
	["typebox", {
		Type: {
			Object: (properties) => ({ kind: "object", properties }),
			String: (options) => ({ kind: "string", options }),
			Optional: (schema) => schema,
		},
	}],
	["@earendil-works/pi-ai", {
		StringEnum: (values, options) => ({ kind: "enum", values, options }),
	}],
	["@earendil-works/pi-coding-agent", {
		getAgentDir: () => agentDir,
	}],
]);

async function syntheticModule(specifier, namespace) {
	const names = Object.keys(namespace);
	return new vm.SyntheticModule(names, function () {
		for (const name of names) this.setExport(name, namespace[name]);
	}, { identifier: specifier });
}

// Caches one SourceTextModule per local file per load so shared relative
// imports resolve to one evaluated module.
async function linkModule(entryPath, cache) {
	const cached = cache.get(entryPath);
	if (cached) return cached;
	const source = strippedSources.get(entryPath);
	if (source === undefined) throw new Error(`Not a test module: ${entryPath}`);
	const mod = new vm.SourceTextModule(source, { identifier: entryPath });
	cache.set(entryPath, mod);
	await mod.link(async (specifier) => {
		if (!specifier.startsWith(".")) {
			const stub = stubModules.get(specifier);
			return syntheticModule(specifier, stub ?? await import(specifier));
		}
		return linkModule(path.resolve(path.dirname(entryPath), specifier), cache);
	});
	return mod;
}

async function loadGraph(entryPath) {
	const cache = new Map();
	const entry = await linkModule(entryPath, cache);
	await entry.evaluate();
	return cache;
}

async function loadHarness() {
	return (await loadGraph(HARNESS_PATH)).get(HARNESS_PATH).namespace;
}

async function loadChild() {
	return (await loadGraph(CHILD_PATH)).get(CHILD_PATH).namespace;
}

function fakeApi() {
	const api = { tools: [], handlers: {} };
	api.registerTool = (tool) => api.tools.push(tool);
	api.on = (event, handler) => {
		(api.handlers[event] ??= []).push(handler);
	};
	return api;
}

function toolCtx(cwd) {
	return {
		cwd,
		hasUI: false,
		ui: { setStatus: () => {} },
	};
}

function guardEvent(toolName, input) {
	return { type: "tool_call", toolCallId: "t1", toolName, input };
}

async function guardResult(handler, toolName, input, cwd) {
	return handler(guardEvent(toolName, input), toolCtx(cwd ?? fixtureRoot));
}

async function guardBlocked(handler, toolName, input, cwd) {
	const result = await guardResult(handler, toolName, input, cwd);
	assert.ok(result?.block, `expected ${toolName} ${JSON.stringify(input)} to be blocked`);
	return result;
}

async function guardAllowed(handler, toolName, input, cwd) {
	const result = await guardResult(handler, toolName, input, cwd);
	assert.equal(result, undefined, `expected ${toolName} ${JSON.stringify(input)} to be allowed`);
}

function gitRunner(dir, options = {}) {
	return (...args) => execFileSync("git", args, { cwd: dir, ...options, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
}

function initRepo(withCommit) {
	const dir = path.join(fixtureRoot, withCommit ? "repo" : "unborn");
	fs.mkdirSync(dir, { recursive: true });
	const git = gitRunner(dir);
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	if (withCommit) {
		fs.writeFileSync(path.join(dir, "file.txt"), "original\n");
		git("add", ".");
		git("commit", "-qm", "first");
		fs.writeFileSync(path.join(dir, "file.txt"), "changed\n");
	}
	return dir;
}

function bigDiffRepo() {
	const dir = path.join(fixtureRoot, "big-diff");
	fs.mkdirSync(dir, { recursive: true });
	const git = gitRunner(dir);
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	fs.writeFileSync(path.join(dir, "big.txt"), `${"a".repeat(250000)}\n`);
	git("add", ".");
	git("commit", "-qm", "first");
	fs.writeFileSync(path.join(dir, "big.txt"), `${"b".repeat(250000)}\n`);
	return dir;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Pi renders the structured sections when no handler forced a full prompt; a forced
// prompt replaces everything, which is why sections cannot carry the primary text there.
function renderSystemPrompt(options, base) {
	if (options.forceSystemPrompt !== undefined) return options.forceSystemPrompt;
	return [
		base,
		...Object.entries(options.sections).map(([name, text]) => `<${name}>\n${text}\n</${name}>`),
	].join("\n\n");
}

test("primary prompt rides sections so a later subagent catalog section stays visible", async () => {
	const api = fakeApi();
	(await loadHarness()).default(api);
	const handler = api.handlers.before_agent_start[0];
	const options = { forceSystemPrompt: undefined, sections: {} };
	const event = { type: "before_agent_start", prompt: "hi", systemPrompt: "PI BASE PROMPT", systemPromptOptions: options };

	const primaryResult = await handler(event, toolCtx(fixtureRoot));
	assert.equal(primaryResult, undefined, "normal runs must not force a full prompt replacement");
	assert.equal(options.sections.primary, "PRIMARY TEST PROMPT");

	// A later handler on the same event adds the advertised catalog section.
	options.sections.advertised_subagents = "thinker, doer, reviewer, ui-designer";

	const delivered = renderSystemPrompt(options, event.systemPrompt);
	assert.ok(delivered.includes("PI BASE PROMPT"));
	assert.ok(delivered.includes("PRIMARY TEST PROMPT"));
	assert.ok(delivered.includes("thinker, doer, reviewer, ui-designer"), "catalog section added after the primary hook must survive rendering");
});

test("primary instructions survive an existing full system prompt override", async () => {
	const api = fakeApi();
	(await loadHarness()).default(api);
	const handler = api.handlers.before_agent_start[0];
	const forced = "Existing tools, skills, and project instructions";
	const options = { sections: {}, forceSystemPrompt: forced };
	const event = { type: "before_agent_start", prompt: "hi", systemPrompt: forced, systemPromptOptions: options };

	const result = await handler(event, toolCtx(fixtureRoot));
	assert.equal(result.systemPrompt, `${forced}\n\nPRIMARY TEST PROMPT`);
	assert.equal(options.sections.primary, undefined, "forced prompts cannot rely on section updates");
});

test("primary instructions also load when the event exposes only the rendered prompt", async () => {
	const api = fakeApi();
	(await loadHarness()).default(api);
	const handler = api.handlers.before_agent_start[0];
	const result = await handler({ type: "before_agent_start", prompt: "hi", systemPrompt: "Pi base prompt" }, toolCtx(fixtureRoot));
	assert.equal(result.systemPrompt, "Pi base prompt\n\nPRIMARY TEST PROMPT");
});

test("input transform appends the exact suffix only for user input that is not a slash or bang command", async () => {
	const api = fakeApi();
	(await loadHarness()).default(api);
	const handler = api.handlers.input[0];
	const suffix = "\n\nRespond in natural, plain English with complete sentences.";
	assert.deepEqual(
		await handler({ type: "input", text: "hello", source: "interactive" }),
		{ action: "transform", text: `hello${suffix}` },
	);
	assert.deepEqual(
		await handler({ type: "input", text: "hello", source: "rpc" }),
		{ action: "transform", text: `hello${suffix}` },
	);
	assert.deepEqual(await handler({ type: "input", text: "hello", source: "extension" }), { action: "continue" });
	assert.deepEqual(await handler({ type: "input", text: "/model", source: "interactive" }), { action: "continue" });
	assert.deepEqual(await handler({ type: "input", text: "!git status", source: "interactive" }), { action: "continue" });
});

test("child module registers only the git tool and never touches the parent prompt", async () => {
	const api = fakeApi();
	(await loadChild()).default(api);
	assert.deepEqual(api.tools.map((tool) => tool.name), ["git"]);
	assert.deepEqual(Object.keys(api.handlers), ["tool_call"]);
});

test("path guard blocks ~/.aws and github-root listings while project subdirs and bash stay usable", async () => {
	const api = fakeApi();
	(await loadChild()).default(api);
	const guard = api.handlers.tool_call[0];

	assert.ok(fs.existsSync(GITHUB_ROOT), "~/github must exist for this suite");
	const link = path.join(fixtureRoot, "github-link");
	fs.symlinkSync(GITHUB_ROOT, link);

	await guardBlocked(guard, "read", { path: `${AWS_DIR}/credentials` });
	await guardBlocked(guard, "grep", { path: GITHUB_ROOT });
	await guardBlocked(guard, "find", { path: GITHUB_ROOT });
	await guardBlocked(guard, "ls", { path: GITHUB_ROOT });
	await guardBlocked(guard, "grep", {}, GITHUB_ROOT);
	await guardBlocked(guard, "grep", { path: link });
	await guardBlocked(guard, "write", { path: `${AWS_DIR}/new.txt`, content: "x" });
	await guardBlocked(guard, "git", { cwd: AWS_DIR });

	await guardAllowed(guard, "grep", { path: path.join(GITHUB_ROOT, "pi-config") });
	await guardAllowed(guard, "ls", { path: path.join(GITHUB_ROOT, "pi-config") });
	await guardAllowed(guard, "read", { path: path.join(GITHUB_ROOT, "pi-config", "AGENTS.md") });
	await guardAllowed(guard, "grep", {}, fixtureRoot);

	const bashBlock = await guardResult(guard, "bash", { command: `cat ${AWS_DIR}/credentials` });
	assert.equal(bashBlock, undefined, "bash is unrestricted by design and documented as such");
});

test("protected directory symlinks cannot bypass the path guard", async () => {
	const awsReal = path.join(fixtureRoot, "aws-real");
	const githubReal = path.join(fixtureRoot, "github-real");
	fs.mkdirSync(awsReal);
	fs.mkdirSync(githubReal);
	fs.rmdirSync(AWS_DIR);
	fs.rmdirSync(GITHUB_ROOT);
	fs.symlinkSync(awsReal, AWS_DIR);
	fs.symlinkSync(githubReal, GITHUB_ROOT);
	const api = fakeApi();
	(await loadChild()).default(api);
	const guard = api.handlers.tool_call[0];
	await guardBlocked(guard, "read", { path: path.join(AWS_DIR, "credentials") });
	await guardBlocked(guard, "write", { path: path.join(awsReal, "new") });
	await guardBlocked(guard, "find", { path: GITHUB_ROOT });
	await guardBlocked(guard, "grep", { path: githubReal });
});

test("git tool reads status, combined diff, and log from a real repository", async () => {
	const api = fakeApi();
	(await loadChild()).default(api);
	const git = api.tools[0];
	const ctx = toolCtx(initRepo(true));

	const status = await git.execute("id", { action: "status" }, undefined, undefined, ctx);
	assert.match(status.content[0].text, /file\.txt/);

	const diff = await git.execute("id", { action: "diff" }, undefined, undefined, ctx);
	assert.match(diff.content[0].text, /changed/);
	assert.ok(!diff.content[0].text.includes("[Truncated"), "small diffs must not carry a truncation notice");

	const log = await git.execute("id", { action: "log" }, undefined, undefined, ctx);
	assert.match(log.content[0].text, /first/);
});

test("git review includes staged additions and unstaged edits without a HEAD", async () => {
	const api = fakeApi();
	(await loadChild()).default(api);
	const git = api.tools[0];
	const ctx = toolCtx(initRepo(false));
	fs.writeFileSync(path.join(ctx.cwd, "new.txt"), "staged addition\n");
	execFileSync("git", ["add", "new.txt"], { cwd: ctx.cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
	fs.writeFileSync(path.join(ctx.cwd, "new.txt"), "staged addition\nunstaged edit\n");

	const diff = await git.execute("id", { action: "diff" }, undefined, undefined, ctx);
	assert.equal(diff.details.exitCode, 0);
	assert.match(diff.content[0].text, /\+staged addition/);
	assert.match(diff.content[0].text, /\+unstaged edit/);
});

test("oversized git diffs return bounded content with an explicit truncation notice", async () => {
	const api = fakeApi();
	(await loadChild()).default(api);
	const git = api.tools[0];
	const ctx = toolCtx(bigDiffRepo());

	const diff = await git.execute("id", { action: "diff" }, undefined, undefined, ctx);
	assert.equal(diff.details.exitCode, 0);

	const full = gitRunner(ctx.cwd, { encoding: "utf8" })(
		"--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.external=",
		"diff", "HEAD", "--no-ext-diff", "--no-textconv",
	);
	assert.ok(full.length > GIT_OUTPUT_CAP, "fixture diff must exceed the git output cap");
	const notice = `\n\n[Truncated: ${full.length - GIT_OUTPUT_CAP} more characters.]`;
	const returned = diff.content[0].text;
	assert.ok(returned.endsWith(notice), "diff must end with the exact truncation notice");
	assert.ok(returned === full.slice(0, GIT_OUTPUT_CAP) + notice, "bounded content must be the head of the real diff plus the notice");
});

const originalGitEnv = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
try {
	for (const { name, fn } of tests) {
		await fn();
		console.log(`ok - ${name}`);
	}
	console.log(`${tests.length} tests passed`);
} finally {
	fs.rmSync(fixtureRoot, { recursive: true, force: true });
	if (originalGitEnv.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = originalGitEnv.global;
	if (originalGitEnv.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
	else process.env.GIT_CONFIG_NOSYSTEM = originalGitEnv.system;
}
