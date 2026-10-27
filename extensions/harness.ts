import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PRIMARY_SUFFIX = "\n\nRespond in natural, plain English with complete sentences.";

const agentDir = getAgentDir();
const PRIMARY_PROMPT_PATH = path.join(agentDir, "agents", "primary.md");

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const primaryPrompt = await fs.promises.readFile(PRIMARY_PROMPT_PATH, "utf8");
		const options = event.systemPromptOptions;
		if (options && options.forceSystemPrompt === undefined) {
			// Structured sections keep later prompt additions visible to the model.
			options.sections.primary = primaryPrompt;
			return undefined;
		}
		// A forced or pre-rendered prompt ignores section updates, so the primary text
		// rides the explicit override instead of being silently dropped.
		return { systemPrompt: `${event.systemPrompt}\n\n${primaryPrompt}` };
	});

	pi.on("input", (event) => {
		if (event.source === "extension") return { action: "continue" };
		if (event.text.startsWith("/") || event.text.startsWith("!")) return { action: "continue" };
		return { action: "transform", text: event.text + PRIMARY_SUFFIX };
	});
}
