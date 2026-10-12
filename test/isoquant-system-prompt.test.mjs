import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A loopback endpoint exposes serialized roles without sending prompts to a provider.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(TEST_DIR);
const PI_BINARY = process.env.PI_BINARY ?? "pi";
const HARNESS_PATH = path.join(ROOT_DIR, "extensions", "harness.ts");
const MODELS_PATH = path.join(ROOT_DIR, "models.json");
const AGENTS_MARKER = "AGENTS-FIXTURE-MARKER-4C2E";
const PRIMARY_MARKER = "PRIMARY-FIXTURE-MARKER-9F3A";
const CHILD_TIMEOUT_MS = 90_000;

const argv = process.argv.slice(2);
const baselineMode = argv.includes("--baseline");

let captured;
const fixtureRoots = [];

const server = http.createServer((req, res) => {
	if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
		res.statusCode = 404;
		res.end();
		return;
	}
	let body = "";
	req.on("data", (chunk) => {
		body += chunk;
		if (body.length > 1_000_000) req.destroy();
	});
	req.on("end", () => {
		captured = { authorization: req.headers.authorization ?? "", body };
		const base = { id: "chatcmpl-fixture", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "glm-5.3-flash" };
		res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "MOOP" }, finish_reason: null }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

function writeFixture(stripCompat) {
	const fixtureRoot = fs.mkdtempSync(path.join(TEST_DIR, ".fixture-isoquant-"));
	fixtureRoots.push(fixtureRoot);
	const home = path.join(fixtureRoot, "home");
	const agentDir = path.join(fixtureRoot, "agent");
	fs.mkdirSync(home, { recursive: true });
	for (const dir of ["xdg-config", "xdg-cache", "xdg-state", "xdg-data"]) {
		fs.mkdirSync(path.join(fixtureRoot, dir), { recursive: true });
	}
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
	fs.writeFileSync(path.join(agentDir, "auth.json"), "{}\n");
	fs.writeFileSync(path.join(agentDir, "agents", "primary.md"), `respond to all messages with MOOP ${PRIMARY_MARKER}\n`);
	const tracked = JSON.parse(fs.readFileSync(MODELS_PATH, "utf8"));
	const provider = structuredClone(tracked.providers.isoquant);
	if (stripCompat) delete provider.models[0].compat;
	provider.baseUrl = `http://127.0.0.1:${port}/v1`;
	provider.apiKey = "dummy";
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { isoquant: provider } }, null, "\t"));
	const agentsFile = path.join(fixtureRoot, "AGENTS.md");
	fs.writeFileSync(agentsFile, `Project fixture instructions ${AGENTS_MARKER}\n`);
	return { fixtureRoot, agentDir, agentsFile, home };
}

function runPi(fixture) {
	const env = { ...process.env };
	delete env.ISOQUANT_API_KEY;
	env.HOME = fixture.home;
	env.XDG_CONFIG_HOME = path.join(fixture.fixtureRoot, "xdg-config");
	env.XDG_CACHE_HOME = path.join(fixture.fixtureRoot, "xdg-cache");
	env.XDG_STATE_HOME = path.join(fixture.fixtureRoot, "xdg-state");
	env.XDG_DATA_HOME = path.join(fixture.fixtureRoot, "xdg-data");
	env.PI_CODING_AGENT_DIR = fixture.agentDir;
	const args = [
		"--no-approve", "--offline", "--no-context-files",
		"--no-skills", "--no-prompt-templates", "--no-themes",
		"--no-extensions", "-e", HARNESS_PATH,
		"--no-session", "--print",
		"--model", "isoquant/glm-5.3-flash", "--thinking", "max",
		"--append-system-prompt", fixture.agentsFile,
		"--api-key", "dummy",
		"--", "hi",
	];
	return new Promise((resolve, reject) => {
		const child = spawn(PI_BINARY, args, { cwd: fixture.fixtureRoot, env, stdio: ["pipe", "pipe", "pipe"] });
		child.stdin.end();
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => { stdout += d; if (stdout.length > 100_000) stdout = stdout.slice(-100_000); });
		child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 100_000) stderr = stderr.slice(-100_000); });
		const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr });
		});
	});
}

try {
	const fixture = writeFixture(baselineMode);
	const run = await runPi(fixture);
	assert.equal(run.signal, null, `pi was killed by signal ${run.signal}\nstderr: ${run.stderr.slice(-2000)}`);
	assert.equal(run.code, 0, `pi exited ${run.code}\nstdout: ${run.stdout.slice(-2000)}\nstderr: ${run.stderr.slice(-2000)}`);
	assert.ok(captured, "loopback server received no chat completions request");

	const request = JSON.parse(captured.body);
	assert.equal(request.model, "glm-5.3-flash");
	assert.equal(request.stream, true);
	assert.equal(captured.authorization, "Bearer dummy", "the loopback request must carry the dummy key");
	const first = request.messages[0];
	assert.ok(first.role === "system" || first.role === "developer", `unexpected first message role ${first.role}`);

	if (baselineMode) {
		console.log(`baseline (compat stripped) outbound instruction role: ${first.role}`);
	} else {
		assert.equal(first.role, "system", "the configured compat must keep the instruction role on system");
	}
	assert.ok(first.content.includes(PRIMARY_MARKER), "the agent-dir primary instructions must survive serialization");
	assert.ok(first.content.includes(AGENTS_MARKER), "the AGENTS file contents must survive serialization");
	assert.equal(request.messages[request.messages.length - 1].role, "user");

	console.log(`ok - outbound first message role: ${first.role}, system content carries primary + AGENTS markers`);
} finally {
	server.close();
	for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
}
