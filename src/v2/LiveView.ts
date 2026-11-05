/** A slow view is resynchronized from canonical state instead of losing deltas. */
export class LiveView<A> {
  private readonly readers = new Set<{ queue: A[]; wake?: () => void }>()
  constructor(private readonly snapshot: () => A, private readonly capacity = 256) {
    if (!Number.isSafeInteger(capacity) || capacity < 2) throw new Error("The live view must hold at least two events.")
  }

  publish(event: A): void {
    for (const reader of this.readers) {
      if (reader.queue.length >= this.capacity) {
        reader.queue = [this.snapshot()]
      } else reader.queue.push(event)
      reader.wake?.()
      delete reader.wake
    }
  }

  events(): AsyncIterable<A> {
    return { [Symbol.asyncIterator]: () => {
      const reader: { queue: A[]; wake?: () => void } = { queue: [] }
      let closed = false
      this.readers.add(reader)
      try { reader.queue.push(this.snapshot()) } catch (error) { this.readers.delete(reader); throw error }
      return {
        next: async (): Promise<IteratorResult<A>> => {
          while (!closed && reader.queue.length === 0) await new Promise<void>((resolve) => { reader.wake = resolve })
          if (closed) return { done: true, value: undefined }
          return { done: false, value: reader.queue.shift()! }
        },
        return: async (): Promise<IteratorResult<A>> => {
          closed = true
          this.readers.delete(reader)
          reader.queue = []
          reader.wake?.()
          delete reader.wake
          return { done: true, value: undefined }
        },
      }
    } }
  }
}
