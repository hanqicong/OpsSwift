import { connect as tcpConnect, isIP } from 'node:net'
import { connect as tlsConnect, checkServerIdentity } from 'node:tls'
import * as nativeTls from 'node:tls'
import { Agent, request } from 'node:https'
import type { Duplex } from 'node:stream'
import sax, { type QualifiedTag } from 'sax'
import { acquire, release } from './ssh'
import type { SshHop } from '../../shared/ssh'

export const PROTOCOL_LIMITS = { deadlineMs: 55_000, messageBytes: 2 * 1024 * 1024, outputBytes: 64 * 1024 }
export type ProtocolTarget = SshHop & { serverId?: string; hops?: SshHop[]; vpnProfileId?: string; cloudTarget?: import('../../shared/cloud').CloudTarget }
export interface ProtocolContext { signal: AbortSignal; check: () => void }
/** Covers dialing, authentication, reads and cleanup; never retries an operation. */
export async function boundedProtocol<T>(fn: (ctx: ProtocolContext) => Promise<T>, check: () => void, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const cancel = (): void => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = setTimeout(cancel, PROTOCOL_LIMITS.deadlineMs)
  const ctx = { signal: controller.signal, check: (): void => { if (controller.signal.aborted) throw new Error('Remote deadline or cancellation; execution state may be unknown'); check() } }
  let rejectAbort: (() => void) | undefined
  try {
    ctx.check()
    const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error('Remote deadline or cancellation; execution state may be unknown')); controller.signal.addEventListener('abort', rejectAbort, { once: true }) })
    return await Promise.race([fn(ctx), aborted])
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort); controller.abort() }
}
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  let aborted = signal.aborted
  let onAbort: () => void = () => {}
  promise.then((value) => { if (aborted) late?.(value) }, () => {})
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      onAbort = () => { aborted = true; reject(new Error('Remote operation cancelled')) }
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true })
    })])
  } finally { signal.removeEventListener('abort', onAbort) }
}
/** Raw TCP never silently bypasses a selected VPN/cloud transport. SSH jump chains are supported. */
export async function openProtocolSocket(cfg: ProtocolTarget, ctx: ProtocolContext): Promise<{ stream: Duplex; close: () => void }> {
  ctx.check()
  if (cfg.cloudTarget || cfg.vpnProfileId) throw new Error('This raw protocol route requires a saved SSH bastion; direct VPN/cloud fallback is disabled')
  const hops = cfg.hops ?? []
  if (hops.length) {
    const conn = await abortable(acquire({ ...hops[hops.length - 1], hops: hops.slice(0, -1) }), ctx.signal, release)
    try {
      ctx.check()
      const stream = await abortable(new Promise<Duplex>((resolve, reject) => conn.client.forwardOut('127.0.0.1', 0, cfg.host, cfg.port, (err, stream) => err ? reject(new Error('Bastion refused remote protocol forwarding')) : resolve(stream))), ctx.signal, (s) => s.destroy())
      const close = (): void => { stream.destroy(); release(conn) }
      let closed = false
      const once = (): void => { if (!closed) { closed = true; ctx.signal.removeEventListener('abort', once); close() } }
      ctx.signal.addEventListener('abort', once, { once: true })
      stream.on('error', () => {})
      return { stream, close: once }
    } catch (e) { release(conn); throw e }
  }
  const stream = tcpConnect({ host: cfg.host, port: cfg.port })
  stream.on('error', () => {})
  const close = (): void => { ctx.signal.removeEventListener('abort', close); stream.destroy() }
  ctx.signal.addEventListener('abort', close, { once: true })
  try {
    await abortable(new Promise<void>((resolve, reject) => { stream.once('connect', resolve); stream.once('error', () => reject(new Error('Remote protocol connection failed'))) }), ctx.signal)
    ctx.check()
    return { stream, close }
  } catch (e) { close(); throw e }
}

export interface XmlNode { name: string; ns: string; attrs: Record<string, string>; children: XmlNode[]; text: string }
export function parseXml(xml: string): XmlNode {
  if (Buffer.byteLength(xml) > PROTOCOL_LIMITS.messageBytes || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) throw new Error('XML limit or DTD/entity declaration refused')
  const options = { xmlns: true, strictEntities: true }
  const p = sax.parser(true, options)
  p.onerror = (error) => { throw error }
  const stack: XmlNode[] = []
  let root: XmlNode | undefined
  let count = 0
  p.onopentag = (tag) => {
    if (++count > 30_000 || stack.length > 64) throw new Error('XML structural limit exceeded')
    const t = tag as QualifiedTag
    const node: XmlNode = { name: t.local, ns: t.uri, attrs: Object.fromEntries(Object.values(t.attributes).map((a) => typeof a === 'string' ? [a, a] : [a.name, a.value])), children: [], text: '' }
    if (stack.length) stack[stack.length - 1].children.push(node)
    else if (root) throw new Error('Multiple XML roots refused')
    else root = node
    stack.push(node)
  }
  p.ontext = p.oncdata = (value) => { if (stack.length) stack[stack.length - 1].text += value }
  p.onclosetag = () => { stack.pop() }
  p.write(xml).close()
  if (!root) throw new Error('Empty XML refused')
  return root
}
export function xmlEscape(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;') }
export function descendants(node: XmlNode, name: string, ns?: string): XmlNode[] { return [ ...(node.name === name && (ns === undefined || node.ns === ns) ? [node] : []), ...node.children.flatMap((c) => descendants(c, name, ns)) ] }

/** One TLS-verified origin, one connection (also required by NTLM), no redirect/proxy/cookie persistence. */
export class ProtocolHttps {
  private agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 })
  private sockets: Array<{ stream: Duplex; close: () => void }> = []
  constructor(private cfg: ProtocolTarget, private ctx: ProtocolContext) {
    this.agent.createConnection = ((_opts: unknown, callback: (err: Error | null, socket?: Duplex) => void) => {
      void openProtocolSocket(cfg, ctx).then((raw) => {
        this.sockets.push(raw)
        ctx.check()
        const caApi = nativeTls as unknown as { getCACertificates?: (kind: string) => string[] }
        let ca: string[] | undefined
        try { if (caApi.getCACertificates) ca = [...new Set([...caApi.getCACertificates('default'), ...caApi.getCACertificates('system')])] } catch { /* Older runtimes retain their default trust roots. */ }
        const tls = tlsConnect({ socket: raw.stream as import('node:net').Socket, servername: isIP(cfg.host) ? undefined : cfg.host, checkServerIdentity: (_name, cert) => checkServerIdentity(cfg.host, cert), rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(ca?.length ? { ca } : {}) })
        let done = false
        tls.once('secureConnect', () => {
          if (done) return
          done = true
          try { ctx.check() }
          catch { tls.destroy(); callback(new Error('Remote authorization changed during TLS setup')); return }
          callback(null, tls)
        })
        tls.on('error', () => { if (!done) { done = true; callback(new Error('Remote TLS certificate or connection failed')) } })
        const stop = (): void => { tls.destroy() }
        ctx.signal.addEventListener('abort', stop, { once: true })
        tls.once('close', () => ctx.signal.removeEventListener('abort', stop))
      }).catch(() => callback(new Error('Remote TLS route failed')))
      return undefined
    }) as typeof this.agent.createConnection
  }
  async post(path: '/command-api' | '/wsman', body: string, headers: Record<string, string>, expectedSocket?: unknown): Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string; socket: unknown }> {
    this.ctx.check()
    if (Buffer.byteLength(body) > PROTOCOL_LIMITS.messageBytes) throw new Error('Request exceeds protocol limit')
    return new Promise((resolve, reject) => {
      const req = request({ hostname: this.cfg.host, port: this.cfg.port, path, method: 'POST', agent: this.agent, signal: this.ctx.signal, headers: { ...headers, 'Content-Length': Buffer.byteLength(body), 'Accept-Encoding': 'identity' } }, (res) => {
        const socket = res.socket
        const chunks: Buffer[] = []
        let bytes = 0
        res.on('data', (b: Buffer) => { bytes += b.length; if (bytes > PROTOCOL_LIMITS.messageBytes) { req.destroy(); reject(new Error('Remote response exceeds protocol limit')) } else chunks.push(b) })
        res.once('error', () => reject(new Error('Remote response failed')))
        res.once('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), socket }))
      })
      req.once('error', () => reject(new Error('Remote HTTPS request failed; execution state may be unknown')))
      req.once('socket', (socket) => {
        try {
          this.ctx.check()
          if (expectedSocket && socket !== expectedSocket) throw new Error('Authenticated connection changed before sending; no retry')
        } catch { req.destroy(); reject(new Error('Remote authorization or authenticated connection changed before sending')) }
      })
      req.end(body)
    })
  }
  close(): void { this.agent.destroy(); for (const raw of this.sockets) raw.close(); this.sockets = [] }
}
