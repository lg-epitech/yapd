import type { ConversationItem, Model, Tool, ToolContext, UserTurn } from "./Types.ts"
import { SupersededError } from "./Types.ts"
import { json, type Store } from "./Store.ts"

export interface AgentOptions {
  readonly conversationId: string
  readonly turn: UserTurn
  readonly model: Model
  readonly tools: ReadonlyArray<Tool>
  readonly store: Store
  readonly signal: AbortSignal
  readonly items: () => ReadonlyArray<ConversationItem>
  readonly context: (invocationId: string) => ToolContext
  readonly text: (delta: string) => void
  readonly result: (invocationId: string, name: string, result: unknown) => void
  readonly maxToolCalls?: number
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Execute complete calls, persist their real outcomes, and continue the same agent. */
export const runAgent = async (options: AgentOptions): Promise<void> => {
  const { store, tools, turn, conversationId, signal } = options
  const definitions = tools.map(({ name, description, parameters, mode }) => ({ name, description, parameters, mode }))
  const names = new Map(tools.map((tool) => [tool.name, tool]))
  let count = 0
  for (;;) {
    if (signal.aborted) throw new SupersededError()
    let continueWithResults = false
    let dynamic = false
    for await (const event of options.model.stream({ items: options.items(), tools: definitions, signal })) {
      if (signal.aborted) throw new SupersededError()
      if (event.type === "text_delta") {
        options.text(event.delta)
        continue
      }
      if (event.type === "done") break
      if (++count > (options.maxToolCalls ?? 12)) throw new Error("The agent reached its tool-call limit. No further actions were run.")
      const tool = names.get(event.name)
      if (event.callId.trim() === "") throw new Error("The model returned a tool call without an ID.")
      const invocationId = `v2:${[conversationId, turn.turnId, `r${turn.revision}`, event.callId].map(encodeURIComponent).join(":")}`
      const mode = tool?.mode ?? "read"
      const prepared = store.prepare({ id: invocationId, conversationId, turnId: turn.turnId, revision: turn.revision, callId: event.callId, name: event.name, arguments: event.arguments, mode })
      if (prepared.fresh) store.appendItem(conversationId, { type: "function_call", callId: event.callId, name: event.name, arguments: event.arguments, turnId: turn.turnId, invocationId })
      let result: unknown
      if (!prepared.fresh) {
        result = prepared.invocation.result ?? { ok: false, status: "unknown", message: "This invocation has already been prepared. Its outcome must be reconciled before any retry." }
      } else {
        let began = false
        try {
          if (tool === undefined) throw new Error(`Unknown tool: ${event.name}`)
          const uncertain = mode === "read" ? undefined : store.uncertain(conversationId, turn.turnId, turn.revision)
          if (uncertain !== undefined) {
            result = { ok: false, status: "unknown", previousInvocationId: uncertain.id, message: "A prior action in this request has an unconfirmed outcome. Further mutations are held; changing tool arguments or IDs cannot retry it. Use read tools to inspect the outcome and explain the uncertainty to the user." }
            store.settle(invocationId, "rejected", result)
          } else {
            const context = options.context(invocationId)
            context.assertCurrent()
            if (mode !== "read") await context.waitForWrite()
            context.assertCurrent()
            store.running(invocationId)
            began = true
            result = await tool.execute(event.arguments, context)
            // Validate before settling; undefined results cannot disappear from history.
            json(result)
            const unknown = mode !== "read" && result !== null && typeof result === "object" && "status" in result && result.status === "unknown"
            store.settle(invocationId, unknown ? "unknown" : "completed", result)
          }
        } catch (error) {
          // Once a write adapter has been entered, even cancellation can race
          // dispatch. Only the adapter's returned receipt can prove it did not go.
          const unknown = began && mode !== "read"
          result = { ok: false, status: unknown ? "unknown" : "rejected", message: message(error) }
          store.settle(invocationId, unknown ? "unknown" : "rejected", result)
        }
      }
      if (prepared.fresh) store.appendItem(conversationId, { type: "function_result", callId: event.callId, name: event.name, result, turnId: turn.turnId, invocationId })
      options.result(invocationId, event.name, result)
      // A dispatched tool is awaited even after interruption, so its outcome remains.
      if (signal.aborted) throw new SupersededError()
      if (event.respond !== undefined) {
        dynamic = true
        await event.respond(result)
      } else continueWithResults = true
    }
    if (signal.aborted) throw new SupersededError()
    if (!continueWithResults || dynamic) return
  }
}
