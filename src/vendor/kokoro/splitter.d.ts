/** Splits text into sentences as it's pushed, for Kokoro to read one at a time. */
export declare class TextSplitterStream implements Iterable<string>, AsyncIterable<string> {
  push(...texts: Array<string>): void
  close(): void
  flush(): void
  get sentences(): Array<string>;
  [Symbol.iterator](): Iterator<string>;
  [Symbol.asyncIterator](): AsyncIterator<string>
}

export declare function split(text: string): Array<string>
