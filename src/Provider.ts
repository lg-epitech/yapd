import { Schema } from "effect"

export const Name = Schema.Literal("codex", "claude", "grok", "antigravity", "opencode", "cursor", "gemini")
export type Name = typeof Name.Type

export interface Call {
  readonly prompt: string
  readonly model: string | undefined
  readonly effort: string | undefined
  /** Like "priority", Codex's fast tier. */
  readonly tier: string | undefined
  /** JSON Schema of the reply, inline and as a file. */
  readonly schema: { readonly json: string; readonly path: string }
}

/** How to run the CLI for a call. */
export interface Invocation {
  readonly argv: ReadonlyArray<string>
  readonly stdin?: string
  /** Added to yapd's own environment. */
  readonly env?: Record<string, string>
}

/** A coding agent CLI run headless, read-only and without the user's setup, as far as each CLI allows. */
export interface Provider {
  /** Used when no model is configured. The tier is a faster service tier, where the CLI has one. */
  readonly defaults?: { readonly model: string; readonly effort: string; readonly tier?: string }
  /** False when the CLI has no reasoning effort setting, only models that bake one in. */
  readonly takesEffort: boolean
  readonly command: (call: Call) => Invocation
  /** Pulls the reply's JSON value out of stdout. Defaults to finding the object in plain text. */
  readonly reply?: (stdout: string) => unknown
  /**
   * The same call, run in a project's checkout to read through it. Only for CLIs
   * that keep the model from changing anything themselves, and were seen to:
   * OpenCode's plan agent, for one, still has its shell and only asks it not to.
   */
  readonly research?: (call: Call) => Invocation
}

const flag = (name: string, value: string | undefined) => (value === undefined ? [] : [name, value])

/** Models without structured output may wrap the object in prose or a code fence. */
export const json = (text: string): unknown => {
  const end = text.lastIndexOf("}")
  // The reply is the last object, so any braces in prose before it are skipped.
  for (let start = text.lastIndexOf("{", end); start !== -1; start = text.lastIndexOf("{", start - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {}
  }
  throw new SyntaxError(`No JSON object in ${JSON.stringify(text)}`)
}

/** Codex's sandbox leaves its shell nothing to write to, in the project or out of it, and no network. */
const codex = ({ prompt, model, effort, tier, schema }: Call) => ({
  argv: [
    "codex", "exec",
    ...flag("--model", model),
    ...flag("--config", effort === undefined ? undefined : `model_reasoning_effort=${effort}`),
    ...flag("--config", tier === undefined ? undefined : `service_tier=${tier}`),
    "--config", "project_doc_max_bytes=0",
    "--output-schema", schema.path,
    "--sandbox", "read-only",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    // Belt and braces with YAPD_INTERNAL: the call must not trigger yapd's own Stop hook.
    "--disable", "hooks",
    "-",
  ],
  stdin: prompt,
})

const claude =
  (tools: string) =>
  ({ prompt, model, effort, schema }: Call) => ({
    argv: [
      "claude", "-p",
      ...flag("--model", model),
      ...flag("--effort", effort),
      "--output-format", "json",
      "--json-schema", schema.json,
      // Prompts end by asking for a JSON object, which other CLIs need. Claude would then often write it out, be told
      // to call StructuredOutput, and send it again: Sonnet did on 9 of 11 replies, at 2 s each.
      "--append-system-prompt", "When asked to reply with a JSON object, give it as the input of the StructuredOutput tool rather than writing it out.",
      "--tools", tools,
      "--setting-sources", "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
    ],
    stdin: prompt,
    // Without these, Claude Code spent about 1.5 s of each call on traffic a one-off call has no use for, like
    // titling the session, before it answered, and another second sending telemetry before it exited. It would
    // also offer the model its Opus advisor tool every time.
    env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" },
  })

export const providers: Record<Name, Provider> = {
  codex: {
    // Luna needs some reasoning to stay coherent. Its fast tier costs no extra usage, unlike bigger models'.
    defaults: { model: "gpt-6-luna", effort: "high", tier: "priority" },
    takesEffort: true,
    command: codex,
    research: codex,
  },
  claude: {
    takesEffort: true,
    command: claude(""),
    // The only tools it's given, so there's no shell and nothing that writes.
    research: claude("Read,Glob,Grep"),
    reply: (stdout) => (JSON.parse(stdout) as { structured_output: unknown }).structured_output,
  },
  grok: {
    takesEffort: true,
    command: ({ prompt, model, effort }) => ({
      argv: ["grok", "--no-auto-update", ...flag("--model", model), ...flag("--effort", effort), "-p", prompt],
    }),
  },
  antigravity: {
    takesEffort: true,
    command: ({ prompt, model, effort }) => ({
      argv: ["agy", ...flag("--model", model), ...flag("--effort", effort), "-p", prompt],
    }),
  },
  opencode: {
    takesEffort: true,
    command: ({ prompt, model, effort }) => ({
      argv: ["opencode", "run", "--pure", "--agent", "plan", ...flag("--model", model), ...flag("--variant", effort), prompt],
    }),
  },
  cursor: {
    takesEffort: false,
    command: ({ prompt, model }) => ({
      argv: ["cursor-agent", "-p", "--output-format", "json", "--mode", "ask", "--trust", ...flag("--model", model), prompt],
    }),
    reply: (stdout) => json((JSON.parse(stdout) as { result: string }).result),
  },
  gemini: {
    takesEffort: false,
    command: ({ prompt, model }) => ({
      argv: ["gemini", "--output-format", "json", "--approval-mode", "plan", ...flag("--model", model), "-p", prompt],
    }),
    reply: (stdout) => json((JSON.parse(stdout) as { response: string }).response),
  },
}
