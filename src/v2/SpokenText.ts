/** Potential formatting waits for completion so split delimiters cannot escape to TTS. */
export const hasFormatting = (text: string): boolean => /[*_`~[\]<>|&\\]|^\s*(?:#{1,6}|[-+](?:\s|$)|-{3,}(?:\s|$)|={3,}(?:\s|$)|\d+[.)](?:\s|$))/m.test(text)

/** Render presentation syntax as speech text, retaining names, numbers and code contents. */
export const spokenText = (text: string): string => Bun.markdown.render(text, {
  paragraph: (children) => `${children}\n`,
  heading: (children) => `${children}\n`,
  listItem: (children) => `${children}\n`,
  code: (children) => `${children}\n`,
  th: (children) => `${children}; `,
  td: (children) => `${children}; `,
  tr: (children) => `${children.replace(/; $/, "")}\n`,
  html: (children) => children.replace(/<!--[^]*?-->|<\/?[a-z][^>]*>/gi, ""),
}).replace(/\n{3,}/g, "\n\n").trimEnd()
