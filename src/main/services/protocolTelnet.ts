import { Duplex } from 'node:stream'
import { terminalDecoder, encodeTerminal } from './terminalCodec'
import { openProtocolSocket, type ProtocolTarget, type ProtocolContext } from './protocolWire'

/** RFC 854 parser: handles split IAC, bounded subnegotiation, escaped data and option refusals. */
export class TelnetCodec {
  private state: 'data' | 'iac' | 'option' | 'sub' | 'subiac' = 'data'
  private command = 0
  private subBytes = 0
  private subData: number[] = []
  private clientOptions = new Set<number>()
  constructor(private size = { cols: 80, rows: 24 }) {}
  resize(cols: number, rows: number): Buffer[] {
    this.size = { cols: Math.max(1, Math.min(65535, Number.isFinite(cols) ? Math.trunc(cols) : 80)), rows: Math.max(1, Math.min(65535, Number.isFinite(rows) ? Math.trunc(rows) : 24)) }
    if (!this.clientOptions.has(31)) return []
    const payload = Buffer.alloc(4); payload.writeUInt16BE(this.size.cols, 0); payload.writeUInt16BE(this.size.rows, 2)
    const escaped: number[] = []; for (const b of payload) { escaped.push(b); if (b === 255) escaped.push(b) }
    return [Buffer.from([255, 250, 31, ...escaped, 255, 240])]
  }
  private offered = new Set<number>()
  private refused = new Set<number>()
  decode(chunk: Buffer): { data: Buffer; replies: Buffer[] } {
    const data: number[] = []
    const replies: Buffer[] = []
    for (const b of chunk) {
      if (this.state === 'data') { if (b === 255) this.state = 'iac'; else data.push(b) }
      else if (this.state === 'iac') {
        if (b === 255) { data.push(255); this.state = 'data' }
        else if ([251, 252, 253, 254].includes(b)) { this.command = b; this.state = 'option' }
        else if (b === 250) { this.subBytes = 0; this.subData = []; this.state = 'sub' }
        else this.state = 'data'
      } else if (this.state === 'option') {
        if (this.command === 251) {
          const supported = b === 1 || b === 3 // server echo and suppress go-ahead
          if (!this.offered.has(b)) { replies.push(Buffer.from([255, supported ? 253 : 254, b])); this.offered.add(b) }
        } else if (this.command === 253) {
          if ([3, 24, 31].includes(b)) { if (!this.clientOptions.has(b)) { this.clientOptions.add(b); replies.push(Buffer.from([255, 251, b])); if (b === 31) replies.push(...this.resize(this.size.cols, this.size.rows)) } }
          else if (!this.refused.has(b)) { replies.push(Buffer.from([255, 252, b])); this.refused.add(b) }
        }
        else if (this.command === 252) this.offered.delete(b)
        else if (this.command === 254) { this.refused.delete(b); this.clientOptions.delete(b) }
        this.state = 'data'
      } else {
        if (++this.subBytes > 8192) throw new Error('Telnet subnegotiation limit exceeded')
        if (this.state === 'subiac') {
          if (b === 240) {
            if (this.subData[0] === 24 && this.subData[1] === 1 && this.clientOptions.has(24)) replies.push(Buffer.from([255, 250, 24, 0, ...Buffer.from('VT100'), 255, 240]))
            this.state = 'data'
          } else { if (b === 255) this.subData.push(255); this.state = 'sub' }
        } else if (b === 255) this.state = 'subiac'
        else this.subData.push(b)
      }
    }
    return { data: Buffer.from(data), replies }
  }
  encode(chunk: Buffer): Buffer {
    const out: number[] = []
    for (let i = 0; i < chunk.length; i++) { const b = chunk[i]; out.push(b); if (b === 255) out.push(b); else if (b === 13 && chunk[i + 1] !== 10 && chunk[i + 1] !== 0) out.push(10) }
    return Buffer.from(out)
  }
}
export async function openTelnet(cfg: ProtocolTarget, ctx: ProtocolContext, size = { cols: 80, rows: 24 }): Promise<{ stream: Duplex; close: () => void; resize: (cols: number, rows: number) => void }> {
  if (cfg.auth !== 'password' || !cfg.password || !cfg.username) throw new Error('Telnet requires a trusted saved password; held credentials cannot be used')
  // Login fields are line-delimited, so terminal controls/newlines would create extra commands.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(cfg.username + cfg.password)) throw new Error('Telnet credentials contain unsupported control characters')
  // Validate before opening the socket; an unrepresentable password must never be submitted partially.
  const username = encodeTerminal(cfg.username + '\r\n', cfg.terminalEncoding)
  const password = encodeTerminal(cfg.password + '\r\n', cfg.terminalEncoding)
  const raw = await openProtocolSocket(cfg, ctx)
  const codec = new TelnetCodec(size)
  const decoded = new Duplex({
    read() { raw.stream.resume() },
    write(chunk: Buffer, _encoding, callback) { try { ctx.check(); raw.stream.write(codec.encode(Buffer.from(chunk)), callback) } catch { callback(new Error('Telnet write refused')) } },
    destroy(error, callback) { raw.close(); callback(error) }
  })
  decoded.on('error', () => {})
  raw.stream.on('data', (chunk: Buffer) => { try { const parsed = codec.decode(chunk); for (const reply of parsed.replies) { ctx.check(); raw.stream.write(reply) }; if (parsed.data.length && !decoded.push(parsed.data)) raw.stream.pause() } catch { decoded.destroy(new Error('Telnet negotiation failed')) } })
  raw.stream.on('error', () => decoded.destroy(new Error('Telnet connection failed')))
  raw.stream.once('close', () => { decoded.push(null); decoded.destroy() })
  try {
    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      let sentUser = false
      let sentPassword = false
      const decoder = terminalDecoder(cfg.terminalEncoding)
      const cleanup = (): void => { decoded.removeListener('data', onData); decoded.removeListener('error', onError); decoded.removeListener('close', onClose); ctx.signal.removeEventListener('abort', onClose) }
      const fail = (): void => { cleanup(); reject(new Error('Telnet login failed; no automatic credential retry')) }
      const onError = (): void => fail()
      const onClose = (): void => fail()
      const onData = (chunk: Buffer): void => {
        buffer += decoder.write(chunk)
        if (Buffer.byteLength(buffer) > 64 * 1024 || /(?:authentication failed|login incorrect|access denied|bad password|password incorrect|认证失败|验证失败|登录失败|密码错误)/i.test(buffer)) return fail()
        const tail = buffer.replace(/[\r\0]/g, '').trimEnd().split('\n').at(-1)?.trim() ?? ''
        try {
          if (/(?:username|login|user name|用户名|用户名称)\s*[:：]\s*$/i.test(tail)) {
            if (sentUser || sentPassword) return fail()
            ctx.check(); decoded.write(username); sentUser = true; buffer = ''
          } else if (/(?:password|密码|口令)\s*[:：]\s*$/i.test(tail)) {
            if (sentPassword) return fail()
            ctx.check(); decoded.write(password); sentPassword = true; buffer = ''
          } else if (tail.length > 0 && tail.length < 180 && /^(?:(?:HRP_[MS])?(?:<[^<>\n]+>|\[[^[\]\n]+\])|[\w.@:-]+(?:\([\w ./:-]+\))?[#>])$/.test(tail)) {
            // A naked prompt must not turn a credential-less connection into anonymous access.
            if (!sentPassword) return fail()
            cleanup(); decoded.pause(); decoded.unshift(encodeTerminal(tail, cfg.terminalEncoding)); resolve()
          }
        } catch { fail() }
      }
      decoded.on('data', onData); decoded.once('error', onError); decoded.once('close', onClose); ctx.signal.addEventListener('abort', onClose, { once: true })
    })
    return { stream: decoded, close: () => { decoded.destroy(); raw.close() }, resize: (cols, rows) => { ctx.check(); for (const reply of codec.resize(cols, rows)) raw.stream.write(reply) } }
  } catch (e) { decoded.destroy(); raw.close(); throw e }
}
