import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(TEST_DIR);
const FOOTER_PATH = path.join(ROOT_DIR, "extensions", "footer.ts");

// The fake host pieces mirror the real footer's layout decisions: dim-wrapped stats with the
// counters first, optional provider prefix, right-aligned model, extension statuses last. The
// wrapper under test slices stats by exact character counts, so the fixture must reproduce that
// structure, including how the truncator behaves at degenerate widths.
const ANSI = /\x1b\[[0-9;]*m/g;
const RESET = "\x1b[0m";
const DIM_OPEN = "\x1b[38;2;128;128;128m\x1b[2m";
const DIM_CLOSE = "\x1b[22;39m";
const dim = (text) => `${DIM_OPEN}${text}${DIM_CLOSE}`;
const visibleWidth = (text) => text.replace(ANSI, "").length;
const plain = (text) => text.replace(ANSI, "");

// ANSI codes stay complete and never count toward width; once the cut is reached pending codes
// are dropped, and the result is fenced with resets like the real pi-tui truncator.
const clip = (text, width) => {
	let out = "";
	let seen = 0;
	for (const token of text.split(/(\x1b\[[0-9;]*m)/)) {
		if (token.startsWith("\x1b[")) {
			if (seen >= width) break;
			out += token;
			continue;
		}
		if (seen >= width) break;
		const take = Math.min(token.length, width - seen);
		out += token.slice(0, take);
		seen += take;
	}
	return out;
};

const truncateToWidth = (text, width, tail = "") => {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const tailWidth = visibleWidth(tail);
	if (tailWidth >= width) {
		const clipped = clip(tail, width);
		return clipped ? `${RESET}${clipped}${RESET}` : "";
	}
	return `${clip(text, width - tailWidth)}${RESET}${tail}${RESET}`;
};

function formatTokens(count) {
	if (count < 1000) return `${count}`;
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

class FooterComponent {
	constructor(session, footerData) {
		this.session = session;
		this.footerData = footerData;
	}
	getSessionStats() {
		return this.session.stats;
	}
	render(width) {
		const { usageTotals, latestCacheHitRate, contextUsage } = this.getSessionStats();
		const contextWindow = contextUsage?.contextWindow ?? 0;
		const percentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent != null ? percentValue.toFixed(1) : "?";
		let pwd = this.session.cwd;
		const branch = this.footerData.getGitBranch();
		if (branch) pwd = `${pwd} (${branch})`;
		if (this.session.sessionName) pwd = `${pwd} • ${this.session.sessionName}`;

		const statsParts = [];
		if (usageTotals.input) statsParts.push(`↑${formatTokens(usageTotals.input)}`);
		if (usageTotals.output) statsParts.push(`↓${formatTokens(usageTotals.output)}`);
		if (usageTotals.cacheRead) statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
		if (usageTotals.cacheWrite) statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
		if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}
		const usingSubscription = this.footerData.usingSubscription;
		if (usageTotals.cost || usingSubscription) {
			statsParts.push(`$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		}
		const autoIndicator = this.session.autoCompactEnabled ? " (auto)" : "";
		statsParts.push(`${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`);
		let statsLeft = statsParts.join(" ");
		let statsLeftWidth = visibleWidth(statsLeft);
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}
		const minPadding = 2;
		let rightSideWithoutProvider = this.session.modelId;
		if (this.session.reasoning) {
			const thinkingLevel = this.session.thinkingLevel || "off";
			rightSideWithoutProvider =
				thinkingLevel === "off" ? `${this.session.modelId} • thinking off` : `${this.session.modelId} • ${thinkingLevel}`;
		}
		const routed = this.session.routedModel;
		if (routed) {
			rightSideWithoutProvider += ` → ${routed.modelId}${routed.thinkingLevel ? ` • ${routed.thinkingLevel}` : ""}`;
		}
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && this.session.modelId) {
			rightSide = `(${this.session.providerId}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) rightSide = rightSideWithoutProvider;
		}
		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
		let statsLine;
		if (totalNeeded <= width) {
			statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
		} else {
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				statsLine = statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight))) + truncatedRight;
			} else {
				statsLine = statsLeft;
			}
		}
		const dimStatsLeft = dim(statsLeft);
		const dimRemainder = dim(statsLine.slice(statsLeft.length));
		const lines = [truncateToWidth(dim(pwd), width, dim("...")), dimStatsLeft + dimRemainder];
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sorted = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => text);
			lines.push(truncateToWidth(sorted.join(" "), width, dim("...")));
		}
		return lines;
	}
}

function fullSession(overrides = {}) {
	return {
		cwd: "~/github/pi-config",
		sessionName: "demo",
		autoCompactEnabled: true,
		modelId: "gpt-6.1-sol",
		providerId: "opencode",
		reasoning: true,
		thinkingLevel: "high",
		routedModel: undefined,
		stats: {
			usageTotals: { input: 1234, output: 2345, cacheRead: 5678, cacheWrite: 891, cost: 0.027 },
			latestCacheHitRate: 72.8,
			contextUsage: { percent: 34.2, contextWindow: 400000 },
		},
		...overrides,
	};
}

function makeComponent(sessionOverrides = {}, footerOverrides = {}) {
	const footerData = {
		usingSubscription: false,
		getGitBranch: () => "main",
		getAvailableProviderCount: () => 2,
		getExtensionStatuses: () => new Map([["b-ext", "beta status"], ["a-ext", "alpha status"]]),
		...footerOverrides,
	};
	return new FooterComponent(fullSession(sessionOverrides), footerData);
}

const zeroStats = {
	usageTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	latestCacheHitRate: undefined,
	contextUsage: { percent: 34.2, contextWindow: 400000 },
};

// Captured before the extension patches the prototype; later tests diff patched renders against
// these to prove the other lines and the counter-free layout stay byte-identical.
const baseline80 = makeComponent().render(80);
const baselineZero = new Map(
	[40, 60, 300].map((width) => [width, makeComponent({ stats: zeroStats }).render(width)]),
);

const stubModules = new Map([
	["@earendil-works/pi-coding-agent", { FooterComponent }],
	["@earendil-works/pi-tui", { visibleWidth, truncateToWidth }],
]);

async function syntheticModule(specifier, namespace) {
	const names = Object.keys(namespace);
	return new vm.SyntheticModule(names, function () {
		for (const name of names) this.setExport(name, namespace[name]);
	}, { identifier: specifier });
}

// A fresh SourceTextModule per load reproduces /reload: the stub FooterComponent class is shared,
// so a second install sees the same prototype as the first.
async function loadFooterExtension() {
	const source = stripTypeScriptTypes(fs.readFileSync(FOOTER_PATH, "utf8"));
	const mod = new vm.SourceTextModule(source, { identifier: FOOTER_PATH });
	await mod.link(async (specifier) => {
		if (specifier.startsWith(".")) throw new Error(`Unexpected relative import: ${specifier}`);
		const stub = stubModules.get(specifier);
		return syntheticModule(specifier, stub ?? (await import(specifier)));
	});
	await mod.evaluate();
	return mod.namespace.default;
}

let firstWrapper;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("installing the extension wraps the prototype exactly once", async () => {
	const install = await loadFooterExtension();
	install({});
	firstWrapper = FooterComponent.prototype.render;
	assert.equal(firstWrapper[Symbol.for("pi-config.footer.hideTokenCounters")], true);

	const reinstall = await loadFooterExtension();
	reinstall({});
	assert.equal(FooterComponent.prototype.render, firstWrapper, "/reload must not stack a second wrapper");
});

test("counters are removed while cost, cache hits, context, and the model line stay", () => {
	const lines = makeComponent().render(100);
	const stats = lines[1];
	assert.equal(visibleWidth(stats), 100);
	assert.ok(stats.includes(`CH72.8% $0.027 34.2%/400k (auto)`), stats);
	assert.ok(plain(stats).trimEnd().endsWith(`(opencode) gpt-6.1-sol • high`), stats);
	assert.equal(plain(stats).trimEnd().length, 100, "model must stay right-aligned");
	assert.ok(!/[↑↓]/.test(stats), stats);
	assert.ok(!/\b[RW][0-9]/.test(stats), stats);
	assert.equal(stats.split(DIM_OPEN).length - 1, 2, "both dim spans must survive");
	assert.equal(stats.split(DIM_CLOSE).length - 1, 2);
	assert.ok(stats.startsWith(DIM_OPEN));
	assert.ok(stats.endsWith(DIM_CLOSE));
});

test("the freed counter width restores the provider prefix", () => {
	const lines = makeComponent().render(80);
	assert.ok(baseline80[1].includes("↑1.2k"), "baseline fixture sanity");
	assert.ok(lines[1].includes(`(opencode) gpt-6.1-sol • high`), lines[1]);
	assert.ok(lines[1].includes("CH72.8% $0.027 34.2%/400k (auto)"), lines[1]);
	assert.equal(visibleWidth(lines[1]), 80);
});

test("pwd line and extension statuses come from the normal-width render", () => {
	const lines = makeComponent().render(80);
	assert.equal(lines[0], baseline80[0]);
	assert.equal(lines[2], baseline80[2]);
	assert.equal(lines.length, baseline80.length);
	assert.equal(lines[2], "alpha status beta status");
});

test("subscription marker and routed model survive the patch", () => {
	const lines = makeComponent({ routedModel: { modelId: "glm-5.3-flash", thinkingLevel: "max" } }, { usingSubscription: true }).render(120);
	const stats = lines[1];
	assert.ok(stats.includes(`$0.027 (sub)`), stats);
	assert.ok(stats.includes(`CH72.8%`), stats);
	assert.ok(plain(stats).trimEnd().endsWith(`(opencode) gpt-6.1-sol • high → glm-5.3-flash • max`), stats);
	assert.equal(visibleWidth(stats), 120);
	assert.ok(!/[↑↓]/.test(stats), stats);
});

test("a footer without counters is returned unchanged", () => {
	for (const width of [40, 60, 300]) {
		assert.deepEqual(makeComponent({ stats: zeroStats }).render(width), baselineZero.get(width));
	}
});

test("narrow widths hide counters and keep the stats line well-formed", () => {
	const clippedEllipsis = new Map([[0, ""], [1, "."], [2, ".."], [3, "..."]]);
	for (const width of [0, 1, 2, 3, 4, 5, 8, 12, 23, 24, 25]) {
		const stats = makeComponent().render(width)[1];
		assert.ok(!/[↑↓]/.test(stats), `width ${width}: ${JSON.stringify(stats)}`);
		assert.ok(!/\b[RW][0-9]/.test(stats), `width ${width}: ${JSON.stringify(stats)}`);
		assert.ok(!stats.replace(ANSI, "").includes("\x1b"), `width ${width}: broken escape in ${JSON.stringify(stats)}`);
		assert.ok(visibleWidth(stats) <= width, `width ${width}: ${JSON.stringify(stats)}`);
		if (clippedEllipsis.has(width)) {
			assert.equal(plain(stats), clippedEllipsis.get(width), `width ${width}: ${JSON.stringify(stats)}`);
		} else if (width >= 5) {
			assert.ok(stats.startsWith(`${DIM_OPEN}CH`), `width ${width}: ${JSON.stringify(stats)}`);
		}
	}
});

let failures = 0;
for (const { name, fn } of tests) {
	try {
		await fn();
		console.log(`ok - ${name}`);
	} catch (error) {
		failures++;
		console.error(`not ok - ${name}`);
		console.error(error);
	}
}
console.log(`${tests.length - failures}/${tests.length} tests passed`);
if (failures > 0) process.exitCode = 1;
