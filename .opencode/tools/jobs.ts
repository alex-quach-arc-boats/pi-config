import { tool } from "@opencode-ai/plugin"
import { spawn as spawnProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

type JobRecord = {
  id: string
  dir: string
  agent: string | null
  model: string | null
  title: string | null
  pid: number
  createdAt: string
}

type Event = {
  type?: string
  sessionID?: string
  error?: { name?: string; data?: { message?: string } }
  part?: {
    type?: string
    messageID?: string
    text?: string
    cost?: number
    tokens?: Record<string, number>
    error?: { name?: string; data?: { message?: string } }
  }
}

type JobState = "running" | "succeeded" | "failed" | "lost"

const stateRoot = path.join(
  process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
  "opencode-jobs",
)

function shq(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function resolveOpencode() {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue
    const candidate = path.join(dir, "opencode")
    if (fs.existsSync(candidate)) return candidate
  }
  const fallback = path.join(os.homedir(), ".opencode", "bin", "opencode")
  if (fs.existsSync(fallback)) return fallback
  throw new Error("opencode binary not found on PATH or in ~/.opencode/bin")
}

// The wrapper keeps opencode's stdout as a plain file with no pipe in between,
// so the job survives this harness process dying and its state is written by
// the shell, not by an interpreter that a SIGKILL could take out mid-write.
function wrapper(jobDir: string) {
  return [
    `op=$1`,
    `shift`,
    `"$op" run "$@" < ${shq(path.join(jobDir, "prompt.txt"))} > ${shq(path.join(jobDir, "events.jsonl"))} 2> ${shq(path.join(jobDir, "stderr.log"))}`,
    `rc=$?`,
    `printf %s "$rc" > ${shq(path.join(jobDir, "exit.tmp"))}`,
    `mv ${shq(path.join(jobDir, "exit.tmp"))} ${shq(path.join(jobDir, "exit"))}`,
  ].join("\n")
}

function age(createdAt: string) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(createdAt)) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h`
}

function pgidAlive(pid: number) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

async function readExit(id: string) {
  const raw = await fsp.readFile(path.join(stateRoot, id, "exit"), "utf8").catch(() => null)
  if (raw === null) return null
  return Number.parseInt(raw, 10)
}

async function parseEvents(id: string) {
  const raw = await fsp.readFile(path.join(stateRoot, id, "events.jsonl"), "utf8").catch(() => "")
  const events: Event[] = []
  for (const line of raw.split("\n")) {
    if (!line) continue
    // A live job's last line can be cut mid-object, so unparseable lines are skipped.
    try {
      events.push(JSON.parse(line) as Event)
    } catch {}
  }
  return events
}

async function hasErrorEvent(events: Event[]) {
  return events.some((event) => event.type === "error")
}

// Terminal states must only be reported from events read after the exit marker
// appeared, since the wrapper closes events.jsonl before writing the marker.
async function jobSnapshot(id: string, pid: number) {
  let exitCode = await readExit(id)
  let events = await parseEvents(id)
  if (exitCode === null) {
    if (pgidAlive(pid)) return { state: "running" as JobState, events }
    exitCode = await readExit(id)
    if (exitCode === null) return { state: "lost" as JobState, events: await parseEvents(id) }
    events = await parseEvents(id)
  }
  const failed = exitCode !== 0 || (await hasErrorEvent(events))
  return { state: (failed ? "failed" : "succeeded") as JobState, events }
}

// The final answer is the text of the last assistant message, since earlier
// messages narrate intermediate steps between tool calls.
function finalText(events: Event[]) {
  const messages = new Map<string, string[]>()
  for (const event of events) {
    const part = event.part
    if (event.type === "text" && part?.messageID && typeof part.text === "string") {
      const texts = messages.get(part.messageID) ?? []
      texts.push(part.text)
      messages.set(part.messageID, texts)
    }
  }
  const last = [...messages.keys()].pop()
  return last ? (messages.get(last) ?? []).join("") : ""
}

async function readRecord(id: string) {
  const raw = await fsp.readFile(path.join(stateRoot, id, "job.json"), "utf8").catch(() => null)
  if (raw === null) throw new Error(`Unknown job ${id}`)
  return JSON.parse(raw) as JobRecord
}

async function list(directory: string) {
  const entries = await fsp.readdir(stateRoot, { withFileTypes: true }).catch(() => [])
  const rows: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const record = await fsp
      .readFile(path.join(stateRoot, entry.name, "job.json"), "utf8")
      .then((raw) => JSON.parse(raw) as JobRecord)
      .catch(() => null)
    if (record === null || record.dir !== directory) continue
    const { state } = await jobSnapshot(entry.name, record.pid)
    const prompt = await fsp
      .readFile(path.join(stateRoot, entry.name, "prompt.txt"), "utf8")
      .catch(() => "")
    const head = prompt.slice(0, 80).replaceAll("\n", " ")
    rows.push(`${entry.name}  ${state}  ${age(record.createdAt)} ago  ${head}`)
  }
  if (rows.length === 0) return `No jobs spawned from ${directory}.`
  // Ids begin with a base36 timestamp, so a string sort orders jobs by age.
  return rows.sort().reverse().join("\n")
}

async function describe(id: string) {
  const record = await readRecord(id)
  const { state, events } = await jobSnapshot(id, record.pid)
  const lines = [`job ${id} is ${state}`, `started ${age(record.createdAt)} ago in ${record.dir}`]

  const agent = record.agent ?? "the default agent"
  lines.push(`agent ${agent}${record.model ? ` on ${record.model}` : ""}`)

  const sessionId = events.findLast((event) => event.sessionID)?.sessionID
  if (sessionId) lines.push(`session ${sessionId}, resumable with opencode run -s ${sessionId}`)

  const stepFinish = events.filter((event) => event.part?.type === "step-finish")
  const tokens = stepFinish.findLast((event) => event.part?.tokens)?.part?.tokens
  const cost = stepFinish.reduce((sum, event) => sum + (event.part?.cost ?? 0), 0)
  if (tokens) lines.push(`tokens ${tokens.input} input, ${tokens.output} output, ${tokens.reasoning} reasoning, cost ${cost}`)

  const output = finalText(events)
  if (output) {
    lines.push(state === "running" ? "answer so far:" : "answer:")
    lines.push(output)
  } else if (state === "running") {
    lines.push("no answer text yet")
  }

  if (state === "failed") {
    const exitCode = await readExit(id)
    if (exitCode !== null && exitCode !== 0) lines.push(`exit code ${exitCode}`)
    for (const event of events) {
      if (event.type === "error") {
        const message =
          event.error?.data?.message ??
          event.error?.name ??
          event.part?.error?.data?.message ??
          event.part?.error?.name ??
          "unknown"
        lines.push(`error ${message}`)
      }
    }
    const stderr = await fsp.readFile(path.join(stateRoot, id, "stderr.log"), "utf8").catch(() => "")
    if (stderr) lines.push(`stderr tail:\n${stderr.slice(-2000)}`)
  }

  if (state === "lost") {
    lines.push(`the wrapper process (pid ${record.pid}) is gone without writing an exit code`)
  }

  return lines.join("\n")
}

export const spawn = tool({
  description:
    "Spawn a headless opencode job in a separate OS process. The job runs the prompt with opencode run in the current project directory, auto-approves permissions, and returns immediately. Query it later with jobs_status.",
  args: {
    prompt: tool.schema.string().min(1).describe("Prompt for the job to carry out."),
    agent: tool.schema.string().optional().describe("Primary agent to run the job with. Defaults to the configured default agent."),
    model: tool.schema.string().optional().describe("Model override in provider/model format."),
    title: tool.schema.string().optional().describe("Session title for the job."),
  },
  async execute(args, context) {
    if (process.env.OPENCODE_JOB_ID) throw new Error("Refusing to spawn a job from inside a spawned job.")

    const opencode = resolveOpencode()
    const id = `j${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
    const jobDir = path.join(stateRoot, id)
    await fsp.mkdir(stateRoot, { recursive: true })
    // Non-recursive mkdir makes an id collision fail loudly instead of reusing a job directory.
    await fsp.mkdir(jobDir)
    await fsp.writeFile(path.join(jobDir, "prompt.txt"), args.prompt)

    const runArgs = ["--auto", "--format", "json", "--dir", context.directory]
    if (args.agent) runArgs.push("--agent", args.agent)
    if (args.model) runArgs.push("--model", args.model)
    if (args.title) runArgs.push("--title", args.title)

    const child = spawnProcess("sh", ["-c", wrapper(jobDir), "sh", opencode, ...runArgs], {
      cwd: jobDir,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, OPENCODE_JOB_ID: id },
    })
    // A failed launch must not surface as an uncaught error in the plugin host.
    child.on("error", () => {})
    if (child.pid === undefined) throw new Error("Failed to spawn the job wrapper process.")

    const record: JobRecord = {
      id,
      dir: context.directory,
      agent: args.agent ?? null,
      model: args.model ?? null,
      title: args.title ?? null,
      pid: child.pid,
      createdAt: new Date().toISOString(),
    }
    try {
      await fsp.writeFile(path.join(jobDir, "job.json.tmp"), JSON.stringify(record, null, 2))
      await fsp.rename(path.join(jobDir, "job.json.tmp"), path.join(jobDir, "job.json"))
    } catch (error) {
      // Without job.json the running job would be undiscoverable, so take it down with the group kill.
      try {
        process.kill(-child.pid, "SIGTERM")
      } catch {}
      throw error
    }
    child.unref()

    return `Spawned job ${id} (pid ${record.pid}) running in ${context.directory}. Query it with jobs_status(id: "${id}").`
  },
})

export const status = tool({
  description:
    "Report the state of spawned opencode jobs. Without an id, list all jobs spawned from the current directory. With an id, return the job's state, usage, and final answer text.",
  args: {
    id: tool.schema.string().optional().describe("Job id from jobs_spawn. Omit to list all jobs for the current directory."),
  },
  async execute(args, context) {
    if (args.id === undefined) return list(context.directory)
    return describe(args.id)
  },
})
