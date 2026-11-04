import { Database } from "bun:sqlite"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { ConversationItem, InputSource, ThreadRef, ToolDefinition, UserTurn } from "./Types.ts"

export interface StoredTurn extends UserTurn {
  readonly conversationId: string
  readonly responseId: string
}

export interface Invocation {
  readonly id: string
  readonly conversationId: string
  readonly turnId: string
  readonly revision: number
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly mode: ToolDefinition["mode"]
  readonly state: "prepared" | "running" | "completed" | "rejected" | "unknown"
  readonly result?: unknown
}

export interface Playback {
  readonly responseId: string
  readonly playedMs: number
  readonly state: "playing" | "finished" | "interrupted"
  readonly certainty: "exact" | "approximate"
  readonly playedText?: string
}

interface TurnRow {
  conversation_id: string
  turn_id: string
  revision: number
  user_text: string
  source: InputSource
  focus: string | null
  response_id: string
}

interface InvocationRow {
  id: string
  conversation_id: string
  turn_id: string
  revision: number
  call_id: string
  name: string
  arguments: string
  mode: ToolDefinition["mode"]
  state: Invocation["state"]
  result: string | null
}

/** Reject non-serializable receipts before they can become canonical history. */
export const json = (value: unknown): string => {
  const encoded = JSON.stringify(value, (_key, part: unknown) => {
    if (typeof part === "undefined" || typeof part === "function" || typeof part === "symbol" || typeof part === "bigint" || (typeof part === "number" && !Number.isFinite(part))) {
      throw new Error("Conversation records must contain only JSON values.")
    }
    return part
  })
  if (encoded === undefined) throw new Error("Conversation records must be JSON values.")
  return encoded
}

const turn = (row: TurnRow): StoredTurn => ({
  conversationId: row.conversation_id,
  turnId: row.turn_id,
  revision: row.revision,
  userText: row.user_text,
  source: row.source,
  responseId: row.response_id,
  ...(row.focus === null ? {} : { focus: JSON.parse(row.focus) as ThreadRef }),
})

const invocation = (row: InvocationRow): Invocation => ({
  id: row.id,
  conversationId: row.conversation_id,
  turnId: row.turn_id,
  revision: row.revision,
  callId: row.call_id,
  name: row.name,
  arguments: JSON.parse(row.arguments) as unknown,
  mode: row.mode,
  state: row.state,
  ...(row.result === null ? {} : { result: JSON.parse(row.result) as unknown }),
})

/** A small durable log, separate from V1's best-effort journal. */
export class Store {
  readonly database: Database

  constructor(path: string = ":memory:") {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(path, "", { flag: "a", mode: 0o600 })
    }
    this.database = new Database(path, { create: true, strict: true })
    this.database.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;")
    this.database.exec(`
      create table if not exists v2_turns (
        conversation_id text not null, turn_id text not null, revision integer not null,
        user_text text not null, source text not null, focus text, response_id text not null,
        primary key (conversation_id, turn_id), unique (conversation_id, revision)
      ) strict;
      create table if not exists v2_events (
        sequence integer primary key autoincrement, conversation_id text not null,
        type text not null, data text not null, at integer not null
      ) strict;
      create index if not exists v2_events_conversation on v2_events (conversation_id, sequence);
      create table if not exists v2_invocations (
        id text primary key, conversation_id text not null, turn_id text not null,
        revision integer not null, call_id text not null, name text not null,
        arguments text not null, mode text not null, state text not null, result text
      ) strict;
      create table if not exists v2_playback (
        conversation_id text not null, response_id text not null, data text not null,
        primary key (conversation_id, response_id)
      ) strict;
    `)
  }

  close(): void { this.database.close() }

  append(conversationId: string, type: string, data: unknown): void {
    this.database.query("insert into v2_events (conversation_id,type,data,at) values (?,?,?,?)")
      .run(conversationId, type, json(data), Date.now())
  }

  appendItem(conversationId: string, item: ConversationItem): void { this.append(conversationId, "item", item) }

  commit(input: Omit<StoredTurn, "revision">): { readonly turn: StoredTurn; readonly duplicate: boolean } {
    return this.database.transaction(() => {
      const existing = this.getTurn(input.conversationId, input.turnId)
      if (existing !== undefined) {
        if (existing.userText !== input.userText || existing.source !== input.source) throw new Error("A committed turn cannot be replaced under the same ID.")
        return { turn: existing, duplicate: true }
      }
      const revision = this.revision(input.conversationId) + 1
      this.database.query("insert into v2_turns values (?,?,?,?,?,?,?)").run(
        input.conversationId, input.turnId, revision, input.userText, input.source,
        input.focus === undefined ? null : json(input.focus), input.responseId,
      )
      const committed = { ...input, revision }
      this.append(input.conversationId, "turn", committed)
      this.appendItem(input.conversationId, { type: "message", role: "user", text: input.userText, turnId: input.turnId })
      return { turn: committed, duplicate: false }
    }).immediate()
  }

  revision(conversationId: string): number {
    return this.database.query<{ revision: number | null }, [string]>("select max(revision) as revision from v2_turns where conversation_id=?")
      .get(conversationId)?.revision ?? 0
  }

  getTurn(conversationId: string, turnId: string): StoredTurn | undefined {
    const found = this.database.query<TurnRow, [string, string]>("select * from v2_turns where conversation_id=? and turn_id=?").get(conversationId, turnId)
    return found === null ? undefined : turn(found)
  }

  items(conversationId: string, limit?: number): ReadonlyArray<ConversationItem> {
    const rows = limit === undefined
      ? this.database.query<{ data: string }, [string]>("select data from v2_events where conversation_id=? and type='item' order by sequence").all(conversationId)
      : this.database.query<{ data: string }, [string, number]>("select data from (select sequence,data from v2_events where conversation_id=? and type='item' order by sequence desc limit ?) order by sequence").all(conversationId, limit)
    return rows.map(({ data }) => JSON.parse(data) as ConversationItem)
  }

  /** Generated text is context immediately, even while a tool receipt is pending. */
  projection(conversationId: string, limit?: number): ReadonlyArray<ConversationItem> {
    const items: ConversationItem[] = []
    const responses = new Map<string, number>()
    for (const event of this.events(conversationId)) {
      if (event.type === "session_event") {
        const response = event.data as { type: string; responseId?: string; turnId?: string }
        if (response.type === "response_started" && response.responseId !== undefined && response.turnId !== undefined && !responses.has(response.responseId)) {
          responses.set(response.responseId, items.length)
          items.push({ type: "message", role: "assistant", text: "", turnId: response.turnId, responseId: response.responseId })
        }
      } else if (event.type === "item") {
        const item = event.data as ConversationItem
        if (item.type === "message" && item.role === "assistant" && item.responseId !== undefined) {
          const at = responses.get(item.responseId)
          if (at !== undefined) { items[at] = item; continue }
          responses.set(item.responseId, items.length)
        }
        items.push(item)
      } else if (event.type === "generated_text") {
        const part = event.data as { responseId: string; turnId: string; delta: string; source?: InputSource }
        let at = responses.get(part.responseId)
        if (at === undefined) {
          at = items.length
          responses.set(part.responseId, at)
          items.push({ type: "message", role: "assistant", text: "", turnId: part.turnId, responseId: part.responseId, ...(part.source === undefined ? {} : { source: part.source }) })
        }
        const before = items[at]
        if (before?.type === "message") items[at] = { ...before, text: before.text + part.delta }
      }
    }
    return limit === undefined ? items : items.slice(-limit)
  }

  events(conversationId: string): ReadonlyArray<{ readonly sequence: number; readonly type: string; readonly data: unknown }> {
    return this.database.query<{ sequence: number; type: string; data: string }, [string]>("select sequence,type,data from v2_events where conversation_id=? order by sequence")
      .all(conversationId).map(({ sequence, type, data }) => ({ sequence, type, data: JSON.parse(data) as unknown }))
  }

  prepare(input: Omit<Invocation, "state" | "result">): { readonly invocation: Invocation; readonly fresh: boolean } {
    return this.database.transaction(() => {
      const existing = this.getInvocation(input.id)
      if (existing !== undefined) {
        if (existing.name !== input.name || json(existing.arguments) !== json(input.arguments)) throw new Error("An invocation ID cannot be reused for another action.")
        return { invocation: existing, fresh: false }
      }
      this.database.query("insert into v2_invocations values (?,?,?,?,?,?,?,?,?,?)").run(
        input.id, input.conversationId, input.turnId, input.revision, input.callId,
        input.name, json(input.arguments), input.mode, "prepared", null,
      )
      this.append(input.conversationId, "invocation_prepared", input)
      return { invocation: { ...input, state: "prepared" as const }, fresh: true }
    }).immediate()
  }

  getInvocation(id: string): Invocation | undefined {
    const found = this.database.query<InvocationRow, [string]>("select * from v2_invocations where id=?").get(id)
    return found === null ? undefined : invocation(found)
  }

  uncertain(conversationId: string, turnId: string, revision: number): Invocation | undefined {
    // Argument spelling is not an action identity: a model can add a default,
    // paraphrase a message, or choose another tool after losing a receipt.
    const found = this.database.query<InvocationRow, [string, string, number]>("select * from v2_invocations where conversation_id=? and turn_id=? and revision=? and state='unknown' and mode in ('write','approval') limit 1")
      .get(conversationId, turnId, revision)
    return found === null ? undefined : invocation(found)
  }

  running(id: string): void {
    const result = this.database.query("update v2_invocations set state='running' where id=? and state='prepared'").run(id)
    if (result.changes !== 1) throw new Error("The invocation is not prepared for execution.")
  }

  settle(id: string, state: "completed" | "rejected" | "unknown", result: unknown): void {
    this.database.transaction(() => {
      const found = this.getInvocation(id)
      if (found === undefined) throw new Error("Cannot settle an unknown invocation.")
      this.database.query("update v2_invocations set state=?,result=? where id=?").run(state, json(result), id)
      this.append(found.conversationId, "invocation_settled", { id, state, result })
    }).immediate()
  }

  recover(conversationId: string): ReadonlyArray<Invocation> {
    return this.database.transaction(() => {
      const rows = this.database.query<InvocationRow, [string]>("select * from v2_invocations where conversation_id=?").all(conversationId)
      const items = this.items(conversationId)
      const recovered: Array<Invocation> = []
      for (const row of rows) {
        const unresolved = row.state === "prepared" || row.state === "running"
        const result = unresolved
          ? { ok: false, status: "unknown", message: "The process stopped before this operation's outcome was recorded. It has not been sent again." }
          : row.result === null ? undefined : JSON.parse(row.result) as unknown
        if (unresolved) {
          this.database.query("update v2_invocations set state='unknown',result=? where id=?").run(json(result), row.id)
          this.append(conversationId, "invocation_settled", { id: row.id, state: "unknown", result })
        }
        if (!items.some((item) => item.type === "function_call" && item.invocationId === row.id)) {
          this.appendItem(conversationId, { type: "function_call", callId: row.call_id, name: row.name, arguments: JSON.parse(row.arguments) as unknown, turnId: row.turn_id, invocationId: row.id })
        }
        if (result !== undefined && !items.some((item) => item.type === "function_result" && item.invocationId === row.id)) {
          this.appendItem(conversationId, { type: "function_result", callId: row.call_id, name: row.name, result, turnId: row.turn_id, invocationId: row.id })
        }
        if (unresolved) recovered.push({ ...invocation(row), state: "unknown", result })
      }
      const fragments = new Map<string, { readonly turnId: string; readonly source?: InputSource; text: string }>()
      for (const event of this.events(conversationId)) {
        if (event.type !== "generated_text") continue
        const data = event.data as { responseId: string; turnId: string; delta: string; source?: InputSource }
        const previous = fragments.get(data.responseId)
        if (previous === undefined) fragments.set(data.responseId, { turnId: data.turnId, text: data.delta, ...(data.source === undefined ? {} : { source: data.source }) })
        else previous.text += data.delta
      }
      for (const [responseId, partial] of fragments) {
        if (partial.text !== "" && !items.some((item) => item.type === "message" && item.role === "assistant" && item.responseId === responseId)) {
          this.appendItem(conversationId, { type: "message", role: "assistant", text: partial.text, turnId: partial.turnId, responseId, ...(partial.source === undefined ? {} : { source: partial.source }) })
          this.appendItem(conversationId, { type: "context", eventId: `recovered_response:${responseId}`, text: `The prior response ${responseId} was interrupted by a process stop. Its recorded text may be incomplete; playback must be checked independently.` })
        }
      }
      return recovered
    }).immediate()
  }

  playback(conversationId: string, receipt: Playback): boolean {
    if (!Number.isFinite(receipt.playedMs) || receipt.playedMs < 0) throw new Error("Playback position must be a nonnegative duration.")
    return this.database.transaction(() => {
      const previous = this.getPlayback(conversationId, receipt.responseId)
      if (previous !== undefined && (previous.playedMs > receipt.playedMs || (previous.state === "finished" && receipt.state !== "finished"))) return false
      this.database.query("insert into v2_playback values (?,?,?) on conflict(conversation_id,response_id) do update set data=excluded.data")
        .run(conversationId, receipt.responseId, json(receipt))
      this.append(conversationId, "playback", receipt)
      return true
    }).immediate()
  }

  getPlayback(conversationId: string, responseId: string): Playback | undefined {
    const found = this.database.query<{ data: string }, [string, string]>("select data from v2_playback where conversation_id=? and response_id=?").get(conversationId, responseId)
    return found === null ? undefined : JSON.parse(found.data) as Playback
  }
}
