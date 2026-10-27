import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(TEST_DIR);
const HARNESS_PATH = path.join(ROOT_DIR, "extensions", "harness.ts");
const fixtureRoot = fs.mkdtempSync(path.join(TEST_DIR, ".fixture-"));
const agentDir = path.join(fixtureRoot, "agent-dir");
fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
fs.writeFileSync(path.join(agentDir, "agents", "primary.md"), "PRIMARY TEST PROMPT");

const strippedSources = new Map([
	[HARNESS_PATH, stripTypeScriptTypes(fs.readFileSync(HARNESS_PATH, "utf8"))],
]);

const stubModules = new Map([
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
	const entry = await linkModule(entryPath, new Map());
	await entry.evaluate();
	return entry;
}

async function loadHarness() {
	return (await loadGraph(HARNESS_PATH)).namespace;
}

function fakeApi() {
	const api = { handlers: {} };
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

try {
	for (const { name, fn } of tests) {
		await fn();
		console.log(`ok - ${name}`);
	}
	console.log(`${tests.length} tests passed`);
} finally {
	fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
