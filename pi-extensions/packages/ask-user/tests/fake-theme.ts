import type { Theme } from '@earendil-works/pi-coding-agent'

// Marks styling as [colour:text], bold as *text*, strike as ~text~, so tests
// can see which style applied. Only the methods this package calls exist.
const fakeTheme = {
  fg: (colour: string, text: string): string => `[${colour}:${text}]`,
  bold: (text: string): string => `*${text}*`,
  strikethrough: (text: string): string => `~${text}~`
} as unknown as Theme

export { fakeTheme }
