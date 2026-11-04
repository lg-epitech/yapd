import type { Tool } from "./Types.ts"

/** End input without canceling the final reply, clearing history or stopping coding tasks. */
export const createStopListeningTool = (stop: () => Promise<void>): Tool => ({
  name: "stop_listening",
  description: "End hands-free listening when the user finishes the conversation or asks you to stop listening. History is retained and manual Talk can start again. This does not stop any coding task; use stop_run for that.",
  mode: "write",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: async (args, context) => {
    if (args === null || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 0) throw new Error("stop_listening accepts no arguments.")
    await context.waitForWrite()
    context.assertCurrent()
    await stop()
    return { status: "completed", listening: false }
  },
})
