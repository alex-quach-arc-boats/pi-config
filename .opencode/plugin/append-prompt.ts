import type { Plugin } from "@opencode-ai/plugin"

const SUFFIX = "\n\nRespond in natural, plain English with complete sentences."

export const appendPrompt = (async () => {
  return {
    "chat.message": async (input, output) => {
      if (input.agent !== "primary") return

      for (let i = output.parts.length - 1; i >= 0; i--) {
        const part = output.parts[i]
        if (part.type === "text" && !part.synthetic && !part.ignored) {
          part.text += SUFFIX
          return
        }
      }
      output.parts.push({
        id: `prt_${crypto.randomUUID().replaceAll("-", "")}`,
        sessionID: output.message.sessionID,
        messageID: output.message.id,
        type: "text",
        text: SUFFIX.trim(),
      })
    },
  }
}) satisfies Plugin
