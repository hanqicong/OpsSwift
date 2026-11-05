/** Human renderer IPC only. Never imported by the MCP server or CLI bridge. */
import type { WebContents } from 'electron'
import { StringDecoder } from 'node:string_decoder'
import type { Duplex } from 'node:stream'
import type { SshConnectConfig } from '../../shared/ssh'
import { remoteTransport, REMOTE_TRANSPORTS, type RemoteTransport } from '../../shared/remoteProtocol'
import { getCachedServer } from './mcpDataCache'
import { preparedProtocolTarget } from './vpn/transport'
import { sshConnect, sshTest } from './ssh'
import { openTelnet } from './protocolTelnet'

type Config = SshConnectConfig & { serverId?: string; vpnProfileId?: string }
interface Session { owner: WebContents; controller: AbortController; stream?: Duplex; close?: () => void; resize?: (cols: number, rows: number) => void }
const sessions = new Map<string, Session>()
const owners = new WeakSet<WebContents>()
export function nativeTerminalProtocol(cfg: Config): RemoteTransport {
  if (cfg.remoteTransport !== undefined) {
    if (!REMOTE_TRANSPORTS.includes(cfg.remoteTransport)) throw new Error('Unsupported terminal protocol')
    return cfg.remoteTransport
  }
  return remoteTransport(cfg.serverId ? getCachedServer(cfg.serverId)?.tags : undefined)
}
function send(s: Session, channel: string, value: unknown): void { if (!s.owner.isDestroyed()) s.owner.send(channel, value) }
function close(id: string): void { const s = sessions.get(id); if (!s) return; sessions.delete(id); s.controller.abort(); s.close?.(); s.stream?.destroy() }
export function nativeTelnetOwns(id: string): boolean { return sessions.has(id) }
export function nativeTelnetWrite(owner: WebContents, id: string, data: string): void {
  const s = sessions.get(id)
  if (s?.owner.id === owner.id && s.stream && typeof data === 'string' && Buffer.byteLength(data) <= 1024 * 1024) s.stream.write(data)
}
export function nativeTelnetResize(owner: WebContents, id: string, cols: number, rows: number): void {
  const s = sessions.get(id); if (s?.owner.id === owner.id) s.resize?.(cols, rows)
}
export function nativeTelnetClose(owner: WebContents, id: string): void { if (sessions.get(id)?.owner.id === owner.id) close(id) }
export function closeNativeNetworkTerminals(): void { for (const id of [...sessions.keys()]) close(id) }
export async function nativeNetworkConnect(owner: WebContents, cfg: Config): Promise<void> {
  const protocol = nativeTerminalProtocol(cfg)
  if (protocol === 'ssh' || protocol === 'windows-ssh') return sshConnect(owner, preparedProtocolTarget(cfg))
  if (protocol !== 'telnet') throw new Error('This protocol uses dedicated RPC/Windows MCP tools, not an interactive CLI terminal')
  if (cfg.initialCommand) throw new Error('Telnet does not support SSH container commands')
  const target = preparedProtocolTarget(cfg) // Preserve vault/sync-trust errors for the native unlock flow.
  if (sessions.has(cfg.sessionId) || sessions.size >= 64) throw new Error('Terminal session already exists or Telnet session limit reached')
  const s: Session = { owner, controller: new AbortController() }
  sessions.set(cfg.sessionId, s)
  if (!owners.has(owner)) { owners.add(owner); owner.once('destroyed', () => { for (const [id, value] of sessions) if (value.owner === owner) close(id) }) }
  const check = (): void => { if (sessions.get(cfg.sessionId) !== s || owner.isDestroyed() || s.controller.signal.aborted) throw new Error('Telnet terminal closed') }
  const status = (phase: string, message?: string): void => send(s, `ssh:status:${cfg.sessionId}`, { sessionId: cfg.sessionId, phase, ...(message ? { message } : {}) })
  let loginTimer: ReturnType<typeof setTimeout> | undefined
  try {
    status('connecting')
    loginTimer = setTimeout(() => { status('error', 'Telnet connection/login timed out; no automatic credential retry'); close(cfg.sessionId) }, 25_000)
    const raw = await openTelnet(target, { signal: s.controller.signal, check }, { cols: cfg.cols, rows: cfg.rows })
    if (sessions.get(cfg.sessionId) !== s) { raw.close(); return }
    clearTimeout(loginTimer); loginTimer = undefined
    s.stream = raw.stream; s.close = raw.close; s.resize = raw.resize
    const decoder = new StringDecoder('utf8')
    let pending = '', timer: ReturnType<typeof setTimeout> | undefined
    const flush = (): void => { timer = undefined; if (pending) { send(s, `ssh:data:${cfg.sessionId}`, pending); pending = '' } }
    raw.stream.on('data', (b: Buffer) => {
      pending += decoder.write(b)
      if (pending.length > 1024 * 1024) { status('error', 'Telnet terminal output exceeded the pending buffer limit'); close(cfg.sessionId); return }
      timer ??= setTimeout(flush, 0)
    })
    raw.stream.once('error', () => { if (sessions.get(cfg.sessionId) === s) { status('error', 'Telnet terminal connection failed'); close(cfg.sessionId) } })
    raw.stream.once('close', () => { if (timer) clearTimeout(timer); pending += decoder.end(); flush(); if (sessions.get(cfg.sessionId) === s) { send(s, `ssh:close:${cfg.sessionId}`, {}); close(cfg.sessionId) } })
    status('ready')
    raw.stream.resume()
  } catch (error) {
    if (sessions.get(cfg.sessionId) === s) { status('error', error instanceof Error ? error.message : 'Telnet connection failed'); close(cfg.sessionId) }
  } finally { if (loginTimer) clearTimeout(loginTimer) }
}
export async function nativeNetworkTest(cfg: Config): Promise<{ ok: boolean; error?: string }> {
  const protocol = nativeTerminalProtocol(cfg)
  const target = { ...preparedProtocolTarget(cfg), vpnProfileId: cfg.vpnProfileId || undefined }
  if (protocol === 'ssh' || protocol === 'windows-ssh') return sshTest(target, true)
  if (protocol !== 'telnet') return { ok: false, error: 'Use the dedicated protocol MCP query to test this RPC connection' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25_000)
  try {
    const raw = await openTelnet(target, { signal: controller.signal, check: () => { if (controller.signal.aborted) throw new Error('Telnet test cancelled or timed out') } }, { cols: cfg.cols, rows: cfg.rows })
    raw.close(); return { ok: true }
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Telnet test failed' } }
  finally { clearTimeout(timer); controller.abort() }
}
