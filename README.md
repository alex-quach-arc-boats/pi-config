# Pi harness config

A self-contained Pi agent directory that mirrors the OpenCode harness in `quach-harness` and the user config in `dotfiles`. Delegation runs on the pinned `pi-subagents` package and the local extension only handles the primary prompt and the user-input suffix.

## Setup

Install current Pi from pi.dev first. Pi requires Node.js 22.19 or newer. Then install the pinned dependency declared in `settings.json`.

```sh
PI_CODING_AGENT_DIR=/home/alex/github/pi-config pi update --extensions
```

This places `pi-subagents@0.77.0` under `npm/` (git-ignored) without touching the tracked configuration. Restart Pi after the install completes because `/reload` re-runs extensions but a freshly installed dependency is not picked up until a new process loads it.

## Launch

```sh
PI_CODING_AGENT_DIR=/home/alex/github/pi-config pi
```

Launch from any project. Pi reads `settings.json`, `models.json`, `agents/`, `skills/`, and `extensions/harness.ts` from that directory. The local extension applies to the primary run only; every subagent file sets `extensions:` empty, which keeps ambient extensions, including the harness extension, out of children. The subagent package reads its own config from `extensions/subagent/config.json` in the same agent directory. `auth.json`, `sessions/`, `models-store.json`, and `npm/` are ignored by the included `.gitignore`.

## Roles

The package catalog advertises exactly the four configured agents. Built-in package agents are disabled through `subagents.disableBuiltins` and the primary is not a subagent. Its `agents/primary.md` file is body-only, so the package parser (which requires frontmatter `name` and `description`) skips it.

| Agent | Model | Tools |
|---|---|---|
| thinker | opencode/claude-opus-5-5 | read, grep, find, ls |
| doer | isoquant/glm-5.3-flash (thinking max) | read, bash, edit, write, grep, find, ls |
| reviewer | opencode/gpt-6.1-sol | read, grep, find, ls |
| ui-designer | opencode/gpt-5.6-terra | read, grep, find, ls |

Descriptions reuse the original harness agent definitions. Launch natively, for example `subagent({ agent: "thinker", task: "..." })`. With workflow scripts disabled, `tasks: [{ agent, task }, ...]` still runs children in parallel and returns their results in order.

Children run in the background by default (`asyncByDefault: true`) with fresh context (`defaultSubagentContext: fresh`, depth 1). Each agent file opts explicitly into `systemPromptMode: append` plus project context, global context, and the discovered skills catalog, so every inherited context is a declared frontmatter choice rather than a default. Nested delegation is blocked (`allowNestedSubagents: false`). The `doer` declares `thinking: max` in its frontmatter, matching the model-level pin in `settings.json`.

The primary prompt routes work to `thinker`, `doer`, and `reviewer` by name, so no change to the copied prompt body was needed for the switch.

## Missions are off

Missions stay off through `disabledFeatures` and `missions.enabled: false` in `extensions/subagent/config.json`, and subagent tool calls render as summaries through `inlineToolDisplay: "summary"`.

## Parent prompt handling

`extensions/harness.ts` appends `agents/primary.md` to the parent system prompt on every primary run, with two paths.

- Normal runs write the primary text into the structured prompt's `primary` section and return no full-prompt override. Sections that later handlers add, such as the `advertised_subagents` catalog, therefore stay visible to the model instead of being folded away by a forced prompt.
- When another handler already forced a complete prompt, or when the event carries only a rendered prompt, the hook appends the primary text to `event.systemPrompt` explicitly, so the instructions also apply on override paths.

After changing the extension or the primary prompt, run `/reload` in Pi. Launch with `PI_CODING_AGENT_DIR` set as shown above because Pi does not treat this repository's root as its agent directory just because it is the working directory.

## Trust and run visibility

Project repositories can add trusted agent definitions through the package's discovery scopes, and loading them is a trust decision. The Hunk review skill requires shell access, so it cannot function in read-only roles. Active runs are visible in the package's FleetView instead of a custom status counter.

## Files

```
settings.json                      defaults, tool selection, thinking levels, builtin extension exclusions, pinned package, builtins disable
models.json                        isoquant provider (with GLM developer-role compat pin) and GovCloud Bedrock model
agents/                            primary body plus four subagent definitions with model/tools frontmatter
skills/                            brand-guidelines, good-documentation, hunk-review, ux-intake
extensions/subagent/config.json    tool activation eager, background children by default, fresh context, depth 1, schedules off, missions off, intercom off
extensions/harness.ts              primary prompt hook and input suffix
test/                              VM-based tests for parent prompt handling plus the loopback serialization test
```

The pinned package's skills and prompts are excluded in the `settings.json` package entry, so only the tracked `skills/` directory applies. Built-in MCP, codemode, and tool search stay disabled through resource exclusions. The provider details for `opencode` and the `isoquant` endpoint, the `Isoquant-ZDR: required` header, and the GovCloud Bedrock entry are otherwise unchanged. `models.json` carries the catalog values, and authentication uses the matching API keys or `/login`.

## GLM instruction role

`models.json` pins `compat.supportsDeveloperRole: false` on the `isoquant/glm-5.3-flash` entry. The exported session shows every instruction section reaching the prompt, so instruction loading worked as designed. For a reasoning model whose provider Pi does not recognize, the outgoing instructions carried the `developer` role, and the pin makes the corrected model send `system`. Whether the server needs `system` or mishandles `developer`, and how it complies with either role, stays unverified here.

Instruction sources update on different clocks. The primary hook rereads `agents/primary.md` on every run, so primary edits land on the next turn, while native `AGENTS.md` and skills caches refresh only on `/reload`. Sessions record their own model, one started on GLM stays on GLM until `/model` changes it, and the configured startup default stays whatever the user chose.

## Tests

Run the suite without installing anything.

```sh
node --experimental-vm-modules /home/alex/github/pi-config/test/harness.test.mjs
```

The suite loads the real `extensions/harness.ts` source into a VM with mocked framework imports and covers the parent prompt paths including the catalog-composition case. It does not load the installed package, launch Pi, or call a model.

The loopback test is separate. It launches the real Pi binary against a local HTTP server and sends no requests to real models or installed folders. It needs a Pi install reachable through `PATH` or through `PI_BINARY` set to a command or path.

```sh
node /home/alex/github/pi-config/test/isoquant-system-prompt.test.mjs
```

It asserts the role of the first outbound message plus the survival of the primary and AGENTS fixture text. With `--baseline` it builds the same fixture with the compat pin stripped and prints the observed role instead of asserting it.
