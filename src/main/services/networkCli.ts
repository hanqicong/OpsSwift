import { createHash, randomUUID } from 'node:crypto'
import { constants, mkdirSync, readdirSync, lstatSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, fsyncSync, renameSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { app, safeStorage } from 'electron'
import type { ClientChannel } from 'ssh2'
import { acquire, release } from './ssh'
import type { SshHop } from '../../shared/ssh'
import type { NetworkChange, NetworkProfile, NetworkQuery } from '../../shared/networkDevice'
import { compileNetworkChanges } from '../../shared/networkDevice'
import { boundedProtocol, abortable } from './protocolWire'
import { openTelnet } from './protocolTelnet'

export const NETWORK_LIMITS = { commandMs: 20_000, workflowMs: 55_000, outputBytes: 5 * 1024 * 1024, planMs: 10 * 60_000, plans: 32, backupBytes: 128 * 1024 * 1024, backupCount: 200, backupDays: 30 }
export function normalizeCli(raw: string): string {
  // eslint-disable-next-line no-control-regex -- strip terminal control sequences from device output
  return raw.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[^\n]\x08/g, '').replace(/\r/g, '').replace(/\x00/g, '')
}
export function configHash(raw: string): string { return createHash('sha256').update(normalizeCli(raw).trim()).digest('hex') }
const CLI_ERROR = /(?:^|\n)\s*(?:%\s*(?:Invalid|Error|Unknown|Incomplete|Ambiguous|Unrecognized|Authorization)|Error:|Unrecognized command|Unknown command|Invalid input|Incomplete command|Ambiguous command|syntax error|error:|Command fail|Permission denied|Not enough privileges|Info:.*(?:failed|failure)|.*\^.*error)/i
const PAGER = /(?:----\s*More\s*----|<---\s*More\s*--->|--\s*[Mm]ore\s*--|Press (?:any key|SPACE|space)|\(q\)uit)/
export function cliHasError(text: string): boolean { return CLI_ERROR.test(text) }
export function promptAtEnd(text: string): string | null {
  const tail = normalizeCli(text).trimEnd().split('\n').at(-1)?.trim() ?? ''
  if (tail.length > 180 || !tail.length) return null
  // A Unix shell ($, user@host:~#) is deliberately not a network prompt.
  if (/^(?:HRP_[MS])?<[^<>\n]+>$/.test(tail) || /^(?:HRP_[MS])?\[[^[\]\n]+\]$/.test(tail)) return tail
  if (/^(?:\([\w .-]+\)\s*|[\w.@:-]+(?:\([\w ./:-]+\))?)[#>]$/.test(tail) || /^\[[\w@.-]+\]\s*>$/.test(tail)) return tail
  return null
}
export interface CliStream {
  on(event: string, listener: (...args: any[]) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
  write(data: string): unknown
  end(): unknown
  destroy(): unknown
}
/** One bounded workflow owns one shell. No shell ID or write primitive is exposed to MCP. */
export class NetworkCli {
  private pending: { resolve: (s: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; initial: boolean; confirmSave: boolean; confirmed: boolean } | null = null
  private buffer = ''
  private decoder = new StringDecoder('utf8')
  private closed = false
  private bytes = 0
  private pages = 0
  private endTimer: ReturnType<typeof setTimeout>
  private quietTimer?: ReturnType<typeof setTimeout>
  private lastPrompt: string | null = null
  constructor(private stream: CliStream, private signal?: AbortSignal, private beforeWrite: () => void = () => {}) {
    stream.on('data', this.onData)
    stream.on('error', this.onError)
    stream.on('close', this.onClose)
    signal?.addEventListener('abort', this.onAbort, { once: true })
    this.endTimer = setTimeout(() => this.fail(new Error('Network workflow deadline exceeded; device state must be verified before retrying')), NETWORK_LIMITS.workflowMs)
  }
  private onAbort = (): void => this.fail(new Error('Network request cancelled; verify state before retrying'))
  private onError = (): void => this.fail(new Error('Network CLI connection failed; device state is unknown'))
  private onClose = (): void => this.fail(new Error('Network CLI closed before completion; device state is unknown'))
  private onData = (chunk: Buffer | string): void => {
    if (this.closed) return
    if (this.quietTimer) { clearTimeout(this.quietTimer); this.quietTimer = undefined }
    this.bytes += Buffer.byteLength(chunk)
    if (this.bytes > NETWORK_LIMITS.outputBytes) return this.fail(new Error('Network output limit exceeded; result is incomplete'))
    this.buffer += this.decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    if (!this.pending) return
    const clean = normalizeCli(this.buffer)
    // Exact save-only confirmation. Never answer a generic password/overwrite/delete prompt.
    if (this.pending.confirmSave && !this.pending.confirmed && /(?:Are you sure.*\[Y\/N\]|continue.*\[Y\/N\]|\[confirm\])\s*[:?]?\s*$/i.test(clean)) {
      this.pending.confirmed = true
      try { this.beforeWrite(); this.stream.write(/\[confirm\]/i.test(clean) ? '\r' : 'y\r') } catch { this.fail(new Error('Network access changed while waiting for confirmation')) }
      return
    }
    if (PAGER.test(clean.slice(-300))) {
      if (++this.pages > 100) return this.fail(new Error('Network pagination limit exceeded; result is incomplete'))
      this.buffer = this.buffer.replace(PAGER, '')
      try { this.beforeWrite(); this.stream.write(' ') } catch { this.fail(new Error('Network access revoked during pagination')) }
      return
    }
    const prompt = promptAtEnd(clean)
    if (!prompt) return
    // A quiet tail avoids accepting a prompt-looking line halfway through a TCP chunk sequence.
    if (this.quietTimer) clearTimeout(this.quietTimer)
    this.quietTimer = setTimeout(() => {
      if (!this.pending || promptAtEnd(this.buffer) !== prompt) return
      const p = this.pending
      clearTimeout(p.timer)
      this.pending = null
      this.lastPrompt = prompt
      const out = normalizeCli(this.buffer).trimEnd().split('\n')
      out.pop()
      const result = out.join('\n').trim()
      if (!p.initial && cliHasError(result)) p.reject(new Error('Device rejected the command; configuration may be partial. Inspect the protected device session before retrying.'))
      else p.resolve(result)
    }, 100)
  }
  private wait(initial: boolean, confirmSave = false): Promise<string> {
    if (this.closed) return Promise.reject(new Error('Network CLI is closed'))
    if (this.pending) return Promise.reject(new Error('A network command is already running'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Network command timed out; device state is unknown, do not retry blindly')), NETWORK_LIMITS.commandMs)
      this.pending = { resolve, reject, timer, initial, confirmSave, confirmed: false }
      if (initial) this.onData('')
    })
  }
  async ready(): Promise<void> { await this.wait(true) }
  async command(command: string, confirmSave = false): Promise<string> {
    if (this.closed) throw new Error('Network CLI is closed')
    if (this.pending) throw new Error('A network command is already running')
    if (!this.lastPrompt) throw new Error('A verified network prompt is required')
    // eslint-disable-next-line no-control-regex -- a command must not contain control characters
    if (/[\r\n\x00-\x1f]/.test(command)) throw new Error('Only one literal CLI command is allowed')
    this.beforeWrite()
    this.buffer = ''
    this.pages = 0
    const pending = this.wait(false, confirmSave)
    try { this.stream.write(command + '\r') } catch { this.fail(new Error('Network CLI write failed; device state is unknown')) }
    const result = await pending
    const lines = result.split('\n')
    if (lines[0]?.trim() === command) lines.shift()
    return lines.join('\n').trim()
  }
  private fail(error: Error): void {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null }
    this.close()
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.endTimer)
    if (this.quietTimer) clearTimeout(this.quietTimer)
    this.signal?.removeEventListener('abort', this.onAbort)
    this.stream.removeListener('data', this.onData)
    this.stream.removeListener('error', this.onError)
    this.stream.removeListener('close', this.onClose)
    // Late errors from a destroyed channel must not become unhandled events.
    this.stream.on('error', () => {})
    this.stream.end()
    this.stream.destroy()
  }
}
const locks = new Set<string>()
export async function withNetworkLock<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
  if (locks.has(serverId)) throw new Error('Another network operation is active on this device')
  locks.add(serverId)
  try { return await fn() } finally { locks.delete(serverId) }
}
export async function withNetworkCli<T>(cfg: SshHop & { serverId?: string; hops?: SshHop[] }, p: NetworkProfile, fn: (cli: NetworkCli) => Promise<T>, signal?: AbortSignal, beforeWrite?: () => void, transport: 'ssh' | 'telnet' = 'ssh'): Promise<T> {
  return boundedProtocol(async (ctx) => {
  if (transport === 'telnet') {
    const raw = await openTelnet(cfg, ctx)
    const cli = new NetworkCli(raw.stream, ctx.signal, ctx.check)
    raw.stream.resume()
    try { await cli.ready(); for (const command of p.paging) await cli.command(command); return await fn(cli) }
    finally { cli.close(); raw.close() }
  }
  const conn = await abortable(acquire(cfg), ctx.signal, release)
  let cli: NetworkCli | undefined
  try {
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      let expired = false
      const timer = setTimeout(() => { expired = true; reject(new Error('Network shell open timed out')) }, NETWORK_LIMITS.commandMs)
      conn.client.shell({ term: 'vt100', cols: 511, rows: 1000 }, (err, stream) => {
        clearTimeout(timer)
        if (err) reject(new Error('Device refused the network CLI shell'))
        else if (ctx.signal.aborted || expired) { stream.destroy(); reject(new Error('Network request cancelled or shell open expired')) }
        else resolve(stream)
      })
    })
    cli = new NetworkCli(stream, ctx.signal, ctx.check)
    await cli.ready()
    for (const command of p.paging) await cli.command(command)
    return await fn(cli)
  } finally { cli?.close(); release(conn) }
  }, beforeWrite ?? (() => {}), signal)
}
export async function networkRead(cli: NetworkCli, p: NetworkProfile, query: NetworkQuery): Promise<string> {
  const command = p.queries[query]
  if (!command) throw new Error('This adapter does not support that query')
  return cli.command(command)
}
export interface NetworkPlan {
  id: string; sessionId: string; serverId: string; revision: number; profileId: string; createdAt: number
  beforeHash: string; commands: string[]; changes: NetworkChange[]; persist: boolean; hash: string; used: boolean
  targetHash: string
}
const plans = new Map<string, NetworkPlan>()
function expireNetworkPlans(now: number): void {
  for (const [id, plan] of plans) if (now - plan.createdAt >= NETWORK_LIMITS.planMs) plans.delete(id)
}
// Bound sensitive in-memory snapshots even when no further plan is requested.
const planExpiryTimer = setInterval(() => expireNetworkPlans(Date.now()), 30_000)
planExpiryTimer.unref()
export function createNetworkPlan(data: Omit<NetworkPlan, 'id' | 'hash' | 'createdAt' | 'used'>, now = Date.now()): NetworkPlan {
  expireNetworkPlans(now)
  if (plans.size >= NETWORK_LIMITS.plans) throw new Error('Network plan capacity reached; let previous plans expire')
  const content = structuredClone(data)
  const plan: NetworkPlan = { ...content, id: randomUUID(), createdAt: now, hash: configHash(JSON.stringify(content)), used: false }
  plans.set(plan.id, plan)
  return structuredClone(plan)
}
export function getNetworkPlan(id: string, hash: string, sessionId: string, serverId: string, now = Date.now(), allowUsed = false): NetworkPlan {
  const p = plans.get(id)
  if (!p || (p.used && !allowUsed) || p.hash !== hash || p.sessionId !== sessionId || p.serverId !== serverId || now - p.createdAt >= NETWORK_LIMITS.planMs) throw new Error('Network plan is absent, expired, consumed, or does not belong to this session and device')
  return structuredClone(p)
}
export function consumeNetworkPlan(id: string): void { const p = plans.get(id); if (!p || p.used) throw new Error('Network plan already consumed'); p.used = true }
export function buildNetworkCommands(p: NetworkProfile, changes: NetworkChange[], persist: boolean): string[] {
  const commands = compileNetworkChanges(p, changes)
  if (p.style === 'junos' && !persist) throw new Error('Junos changes require persist=true because commit is part of the transaction')
  if (persist && p.save) commands.push(p.save)
  return commands
}

export function verifyNetworkChanges(p: NetworkProfile, raw: string, changes: NetworkChange[]): { kind: string; target: string; matched: boolean }[] {
  const lines = normalizeCli(raw).split('\n').map((l) => l.trim())
  return changes.map((c) => {
    if (p.style === 'junos') {
      const prefix = `set interfaces ${c.target} `
      const matched = c.kind === 'interface_description'
        ? lines.includes(`${prefix}description "${c.value}"`) || lines.includes(`${prefix}description ${c.value}`)
        : c.value === 'down' ? lines.includes(`${prefix}disable`) : !lines.includes(`${prefix}disable`)
      return { kind: c.kind, target: c.target, matched }
    }
    const header = c.kind === 'vlan_name' ? `vlan ${c.target}` : `interface ${c.target}`
    const start = lines.indexOf(header)
    let end = start + 1
    while (end < lines.length && !/^(?:interface |vlan |#|!|return$|end$)/.test(lines[end])) end++
    const block = start < 0 ? [] : lines.slice(start + 1, end)
    const wanted = c.kind === 'interface_description' ? `description ${c.value}`
      : c.kind === 'vlan_name' ? `${p.id === 'h3c_comware' ? 'name' : p.style === 'vrp' ? 'description' : 'name'} ${c.value}`
      : c.kind === 'access_vlan' ? `${p.id === 'h3c_comware' ? 'port access vlan' : p.id === 'aruba_aoscx' ? 'vlan access' : p.style === 'vrp' ? 'port default vlan' : 'switchport access vlan'} ${c.value}` : 'shutdown'
    // Absence of shutdown can mean a platform default, disabled hierarchy, or incomplete stanza.
    // Require explicit administrative-up evidence where the CLI preserves it; otherwise report inconclusive.
    const matched = start >= 0 && (c.kind === 'interface_admin' && c.value === 'up' ? block.includes(p.style === 'vrp' ? 'undo shutdown' : 'no shutdown') : block.includes(wanted))
    return { kind: c.kind, target: c.target, matched }
  })
}

/** Complete encrypted artifacts are the unit of retention. No plaintext configuration touches disk. */
export function storeNetworkBackup(raw: string): { id: string; sha256: string; bytes: number; encrypted: true } {
  if (!raw.trim()) throw new Error('Empty configuration cannot be a backup')
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('OS-backed encryption is unavailable; network backup and configuration are refused')
  const dir = join(app.getPath('userData'), 'network-backups')
  mkdirSync(dir, { mode: 0o700, recursive: true })
  if (lstatSync(dir).isSymbolicLink()) throw new Error('Network backup directory cannot be a symbolic link')
  chmodSync(dir, 0o700)
  const bytes = Buffer.byteLength(raw)
  if (bytes > NETWORK_LIMITS.outputBytes) throw new Error('Configuration backup exceeds its size limit')
  const id = randomUUID()
  const sha256 = configHash(raw)
  const encrypted = safeStorage.encryptString(raw)
  const contents = JSON.stringify({ version: 1, id, sha256, bytes, createdAt: Date.now(), ciphertext: encrypted.toString('base64') })
  const files = readdirSync(dir).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).map((name) => ({ name, stat: lstatSync(join(dir, name)) })).filter((f) => f.stat.isFile()).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)
  let total = files.reduce((n, f) => n + f.stat.size, 0)
  let count = files.length
  const pending = join(dir, `${id}.pending`)
  try {
    const fd = openSync(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, contents); fsyncSync(fd) } finally { closeSync(fd) }
    // Read back the sealed envelope before any configuration may follow.
    const saved = JSON.parse(readFileSync(pending, 'utf8')) as { ciphertext: string }
    if (configHash(safeStorage.decryptString(Buffer.from(saved.ciphertext, 'base64'))) !== sha256) throw new Error('Encrypted network backup verification failed')
    renameSync(pending, join(dir, `${id}.json`))
  } catch (error) { try { unlinkSync(pending) } catch { /* no incomplete artifact remains */ } throw error }
  // Never remove a recovery snapshot until its replacement has been durably written and verified.
  for (const f of files) {
    if (Date.now() - f.stat.mtimeMs < NETWORK_LIMITS.backupDays * 86400_000 && total + Buffer.byteLength(contents) <= NETWORK_LIMITS.backupBytes && count < NETWORK_LIMITS.backupCount) break
    unlinkSync(join(dir, f.name)); total -= f.stat.size; count--
  }
  return { id, sha256, bytes, encrypted: true }
}
