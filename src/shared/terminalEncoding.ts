/** A human chooses the byte encoding of a saved CLI connection. No heuristic rewrites device data. */
export class TerminalEncodingError extends Error {}
export const TERMINAL_ENCODINGS = ['utf8', 'gbk', 'gb18030', 'big5'] as const
export type TerminalEncoding = typeof TERMINAL_ENCODINGS[number]
export function parseTerminalEncoding(value: unknown): TerminalEncoding {
  if (value === undefined || value === null || value === '') return 'utf8'
  if (TERMINAL_ENCODINGS.includes(value as TerminalEncoding)) return value as TerminalEncoding
  throw new TerminalEncodingError('Unsupported terminal encoding')
}
export function terminalEncodingFromTags(tags: readonly string[] = []): TerminalEncoding {
  const selected = tags.filter(tag => tag.startsWith('encoding:'))
  if (selected.length > 1) throw new TerminalEncodingError('Ambiguous terminal encoding')
  return parseTerminalEncoding(selected[0]?.slice('encoding:'.length))
}
