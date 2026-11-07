import iconv from 'iconv-lite'
import { TerminalEncodingError, parseTerminalEncoding, type TerminalEncoding } from '../../shared/terminalEncoding'

/** One decoder per independent byte stream. Incomplete multibyte characters survive TCP/SSH chunk boundaries. */
export function terminalDecoder(encoding?: TerminalEncoding): { write: (chunk: Buffer | string) => string; end: () => string } {
  const decoder = iconv.getDecoder(parseTerminalEncoding(encoding), { stripBOM: false })
  return {
    write: chunk => typeof chunk === 'string' ? chunk : decoder.write(chunk),
    end: () => decoder.end() ?? ''
  }
}

/** Refuse lossy legacy input rather than replacing a Chinese name or password with question marks. */
export function encodeTerminal(text: string, encoding?: TerminalEncoding): Buffer {
  const selected = parseTerminalEncoding(encoding)
  const bytes = iconv.encode(text, selected)
  if (iconv.decode(bytes, selected, { stripBOM: false }) !== text) {
    throw new TerminalEncodingError('Input contains characters that cannot be represented by the selected terminal encoding')
  }
  return bytes
}
