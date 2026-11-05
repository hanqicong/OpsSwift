import type { Duplex } from 'node:stream'
import { acquire, release } from './ssh'
import { abortable, parseXml, descendants, xmlEscape, PROTOCOL_LIMITS, type ProtocolTarget, type ProtocolContext } from './protocolWire'

export const NETCONF_NS = 'urn:ietf:params:xml:ns:netconf:base:1.0'
const BASE10 = 'urn:ietf:params:netconf:base:1.0'
const BASE11 = 'urn:ietf:params:netconf:base:1.1'
const END = Buffer.from(']]>]]>')
export class NetconfFramer {
  chunked = false
  private buffer = Buffer.alloc(0)
  private parts: Buffer[] = []
  private bytes = 0
  private expected: number | undefined
  push(chunk: Buffer): void { this.buffer = Buffer.concat([this.buffer, chunk]); if (this.buffer.length + this.bytes > PROTOCOL_LIMITS.messageBytes + 128) throw new Error('NETCONF frame too large') }
  next(): string | undefined {
    if (!this.chunked) {
      const end = this.buffer.indexOf(END)
      if (end < 0) return undefined
      const frame = this.buffer.subarray(0, end).toString('utf8'); this.buffer = this.buffer.subarray(end + END.length); return frame
    }
    while (true) {
      if (this.expected !== undefined) {
        if (this.buffer.length < this.expected) return undefined
        if (this.parts.length >= 10_000) throw new Error('NETCONF chunk count limit exceeded')
        this.parts.push(this.buffer.subarray(0, this.expected)); this.bytes += this.expected
        this.buffer = this.buffer.subarray(this.expected); this.expected = undefined
      }
      if (this.buffer.length < 4) return undefined
      if (this.buffer.subarray(0, 4).equals(Buffer.from('\n##\n'))) {
        if (!this.parts.length) throw new Error('Empty NETCONF chunked frame')
        const message = Buffer.concat(this.parts).toString('utf8'); this.parts = []; this.bytes = 0; this.buffer = this.buffer.subarray(4); return message
      }
      const end = this.buffer.indexOf(10, 1)
      if (end < 0) { if (this.buffer.length > 14) throw new Error('Invalid NETCONF chunk header'); return undefined }
      const header = this.buffer.subarray(0, end + 1).toString('ascii')
      if (!/^\n#[1-9][0-9]{0,9}\n$/.test(header)) throw new Error('Invalid NETCONF chunk length')
      const length = Number(header.slice(2, -1))
      if (length + this.bytes > PROTOCOL_LIMITS.messageBytes) throw new Error('NETCONF message limit exceeded')
      this.expected = length; this.buffer = this.buffer.subarray(end + 1)
    }
  }
}
export function netconfFrame(xml: string, chunked: boolean): Buffer {
  const body = Buffer.from(xml)
  if (body.length > PROTOCOL_LIMITS.messageBytes) throw new Error('NETCONF request exceeds limit')
  return chunked ? Buffer.concat([Buffer.from(`\n#${body.length}\n`), body, Buffer.from('\n##\n')]) : Buffer.concat([body, END])
}
export function validateRpcOperation(xml: string): void {
  if (Buffer.byteLength(xml) > 64 * 1024 || xml.includes(']]>]]>') || /<\?xml/i.test(xml)) throw new Error('RPC operation must be one XML element within 64 KiB')
  const root = parseXml(xml)
  if (['rpc', 'rpc-reply', 'hello', 'notification'].includes(root.name)) throw new Error('Supply the operation element, not an RPC envelope')
}
/** One session owns hello, message IDs and framing. No persistent caller-addressable channel exists. */
export class NetconfSession {
  private framer = new NetconfFramer()
  private queue: string[] = []
  private waiting?: { resolve: (value: string) => void; reject: (error: Error) => void }
  private error?: Error
  private helloSeen = false
  private counter = 0
  private pending = false
  capabilities: string[] = []
  constructor(private stream: Duplex, private ctx: ProtocolContext) {
    stream.on('data', this.onData); stream.on('error', this.onClose); stream.on('close', this.onClose)
    ctx.signal.addEventListener('abort', this.onClose, { once: true })
  }
  private onClose = (): void => { this.error = new Error('NETCONF session ended; RPC execution state may be unknown'); this.waiting?.reject(this.error); this.waiting = undefined }
  private onData = (chunk: Buffer): void => {
    try {
      this.framer.push(chunk)
      let frame: string | undefined
      while ((frame = this.framer.next()) !== undefined) {
        if (!this.helloSeen) {
          const hello = parseXml(frame)
          if (hello.name !== 'hello' || hello.ns !== NETCONF_NS) throw new Error('Invalid NETCONF hello')
          this.capabilities = descendants(hello, 'capability', NETCONF_NS).map((n) => n.text.trim())
          const ids = descendants(hello, 'session-id', NETCONF_NS)
          if ((!this.capabilities.includes(BASE10) && !this.capabilities.includes(BASE11)) || ids.length !== 1 || !/^[1-9]\d*$/.test(ids[0].text.trim())) throw new Error('Invalid NETCONF capabilities/session ID')
          this.helloSeen = true; this.framer.chunked = this.capabilities.includes(BASE11)
        }
        if (this.waiting) { const next = this.waiting; this.waiting = undefined; next.resolve(frame) }
        else { this.queue.push(frame); if (this.queue.length > 8) throw new Error('Unexpected NETCONF message flood') }
      }
    } catch { this.onClose(); this.stream.destroy() }
  }
  private next(): Promise<string> {
    if (this.error) return Promise.reject(this.error)
    if (this.queue.length) return Promise.resolve(this.queue.shift() as string)
    if (this.waiting) return Promise.reject(new Error('Concurrent NETCONF receive refused'))
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject } })
  }
  async hello(): Promise<void> {
    this.ctx.check()
    this.stream.write(netconfFrame(`<hello xmlns="${NETCONF_NS}"><capabilities><capability>${BASE10}</capability><capability>${BASE11}</capability></capabilities></hello>`, false))
    await this.next()
  }
  async rpc(operation: string): Promise<string> {
    validateRpcOperation(operation)
    if (!this.helloSeen || this.pending) throw new Error('NETCONF session is not ready or already has an RPC')
    this.pending = true
    try {
      this.ctx.check()
      const id = String(++this.counter)
      this.stream.write(netconfFrame(`<rpc xmlns="${NETCONF_NS}" message-id="${id}">${operation}</rpc>`, this.framer.chunked))
      const reply = await this.next()
      const node = parseXml(reply)
      if (node.name !== 'rpc-reply' || node.ns !== NETCONF_NS || node.attrs['message-id'] !== id) throw new Error('NETCONF response identity mismatch')
      if (descendants(node, 'rpc-error', NETCONF_NS).length) throw new Error('NETCONF rpc-error returned; no automatic retry')
      if (!node.children.length) throw new Error('NETCONF reply has no result')
      return reply
    } finally { this.pending = false }
  }
  close(): void { this.ctx.signal.removeEventListener('abort', this.onClose); this.stream.removeListener('data', this.onData); this.stream.removeListener('close', this.onClose); this.stream.removeListener('error', this.onClose); this.stream.on('error', () => {}); this.onClose(); this.stream.destroy() }
}
export function netconfReadOperation(kind: 'state' | 'config', filter?: string): string {
  if (filter) { validateRpcOperation(filter); if (Buffer.byteLength(filter) > 16 * 1024) throw new Error('Subtree filter exceeds 16 KiB') }
  const body = filter ? `<filter type="subtree">${filter}</filter>` : ''
  return kind === 'config' ? `<get-config xmlns="${NETCONF_NS}"><source><running/></source>${body}</get-config>` : `<get xmlns="${NETCONF_NS}">${body}</get>`
}
export async function withNetconf<T>(cfg: ProtocolTarget, ctx: ProtocolContext, fn: (session: NetconfSession) => Promise<T>): Promise<T> {
  ctx.check()
  const conn = await abortable(acquire(cfg), ctx.signal, release)
  let session: NetconfSession | undefined
  try {
    ctx.check()
    const stream = await abortable(new Promise<Duplex>((resolve, reject) => conn.client.subsys('netconf', (err, channel) => err ? reject(new Error('SSH NETCONF subsystem refused')) : resolve(channel))), ctx.signal, (s) => s.destroy())
    session = new NetconfSession(stream, ctx)
    await session.hello()
    return await fn(session)
  } finally { session?.close(); release(conn) }
}
// Keep XML escaping exported with the protocol for vendor operation builders.
export { xmlEscape }
