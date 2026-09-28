import { Schema } from "effect"

export const Name = Schema.Literal("codex", "claude", "grok", "antigravity", "opencode", "cursor", "gemini")
export type Name = typeof Name.Type

export interface Call {
  readonly prompt: string
  readonly model: string | undefined
  readonly effort: string | undefined
  /** JSON Schema of the reply, inline and as a file. */
  readonly schema: { readonly json: string; readonly path: string }
}

/** A coding agent CLI run headless, with no tools and none of the user's setup where it allows. */
export interface Provider {
  readonly defaults?: { readonly model: string; readonly effort: string }
  /** False when the CLI has no reasoning effort setting, only models that bake one in. */
  readonly effort: boolean
  readonly command: (call: Call) => { readonly argv: ReadonlyArray<string>; readonly stdin?: string }
  /** Pulls the reply's JSON value out of stdout. */
  readonly reply: (stdout: string) => unknown
}

const flag = (name: string, value: string | undefined) => (value === undefined ? [] : [name, value])

/** Models without structured output may wrap the object in prose or a code fence. */
const json = (text: string): unknown => JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1))

export const providers: Record<Name, Provider> = {
  codex: {
    // Luna needs some reasoning to stay coherent.
    defaults: { model: "gpt-6-luna", effort: "high" },
    effort: true,
    command: ({ prompt, model, effort, schema }) => ({
      argv: [
        "codex", "exec",
        ...flag("--model", model),
        ...flag("--config", effort && `model_reasoning_effort=${effort}`),
        "--config", "project_doc_max_bytes=0",
        "--output-schema", schema.path,
        "--sandbox", "read-only",
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--skip-git-repo-check",
        "--disable", "hooks",
        "-",
      ],
      stdin: prompt,
    }),
    reply: json,
  },
  claude: {
    effort: true,
    command: ({ prompt, model, effort, schema }) => ({
      argv: [
        "claude", "-p",
        ...flag("--model", model),
        ...flag("--effort", effort),
        "--output-format", "json",
        "--json-schema", schema.json,
        "--tools", "",
        "--setting-sources", "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
      ],
      stdin: prompt,
    }),
    reply: (stdout) => (JSON.parse(stdout) as { structured_output: unknown }).structured_output,
  },
  grok: {
    effort: true,
    command: ({ prompt, model, effort }) => ({
      argv: ["grok", "--no-auto-update", ...flag("--model", model), ...flag("--effort", effort), "-p", prompt],
    }),
    reply: json,
  },
  antigravity: {
    effort: true,
    command: ({ prompt, model, effort }) => ({
      argv: ["agy", ...flag("--model", model), ...flag("--effort", effort), "-p", prompt],
    }),
    reply: json,
  },
  opencode: {
    effort: true,
    command: ({ prompt, model, effort }) => ({
      argv: ["opencode", "run", "--pure", ...flag("--model", model), ...flag("--variant", effort), prompt],
    }),
    reply: json,
  },
  cursor: {
    effort: false,
    command: ({ prompt, model }) => ({
      argv: ["cursor-agent", "-p", "--output-format", "json", "--mode", "ask", "--trust", ...flag("--model", model), prompt],
    }),
    reply: (stdout) => json((JSON.parse(stdout) as { result: string }).result),
  },
  gemini: {
    effort: false,
    command: ({ prompt, model }) => ({
      argv: ["gemini", "--output-format", "json", "--approval-mode", "plan", ...flag("--model", model), "-p", prompt],
    }),
    reply: (stdout) => json((JSON.parse(stdout) as { response: string }).response),
  },
}
