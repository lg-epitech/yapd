import { expect, test } from "bun:test"
import { LiveView } from "./LiveView.ts"

test("a slow conversation view recovers the complete canonical text and then continues", async () => {
  let text = ""
  const view = new LiveView<{ type: string; text: string }>(() => ({ type: "snapshot", text }), 3)
  const reader = view.events()[Symbol.asyncIterator]()
  expect((await reader.next()).value).toEqual({ type: "snapshot", text: "" })
  for (const delta of ["Only ", "French ", "tests. ", "No ", "merge."]) {
    text += delta
    view.publish({ type: "delta", text: delta })
  }
  const recovered = (await reader.next()).value
  expect(recovered).toEqual({ type: "snapshot", text: "Only French tests. No " })
  expect((await reader.next()).value).toEqual({ type: "delta", text: "merge." })
  await reader.return?.()
})

test("disconnect releases a reader blocked waiting for live events", async () => {
  const view = new LiveView(() => "snapshot")
  const reader = view.events()[Symbol.asyncIterator]()
  await reader.next()
  const pending = reader.next()
  await reader.return?.()
  expect(await pending).toEqual({ done: true, value: undefined })
})
