import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createServer, type Server as TcpServer, type Socket } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { app } from 'electron'
import { Server as SshServer, utils } from 'ssh2'
import { nativeNetworkConnect, nativeNetworkTest, nativeTelnetOwns, nativeTelnetWrite, nativeTelnetResize, nativeTelnetClose, closeNativeNetworkTerminals } from '../src/main/services/nativeNetworkTerminal'
import { refreshMcpDataCache } from '../src/main/services/mcpDataCache'
import { setSecret } from '../src/main/services/secrets'
import { fingerprint } from '../src/main/services/knownhosts'
import { poolDisposeAll, sshClose, sshWrite, sshExec, sshExecStream } from '../src/main/services/ssh'
import { terminalDecoder, encodeTerminal } from '../src/main/services/terminalCodec'
import type { TerminalEncoding } from '../src/shared/terminalEncoding'
import { TelnetCodec } from '../src/main/services/protocolTelnet'

class WindowFixture extends EventEmitter {
  id = 1
  messages: Array<{ channel: string; value: any }> = []
  destroyed = false
  isDestroyed(): boolean { return this.destroyed }
  send(channel: string, value: unknown): void { this.messages.push({ channel, value }) }
}
let tcp: TcpServer, ssh: SshServer, tcpPort: number, sshPort: number
const sockets = new Set<Socket>()
const sshClients: Array<{ end: () => void }> = []
const lines: string[] = []
const control: Buffer[] = []
let rejectPassword = false
let wireEncoding: TerminalEncoding = 'utf8'
let chineseLogin = false
let expectedPassword = 'synthetic-password'
function cache(transport: 'ssh' | 'telnet', compatibility?: string): void {
  refreshMcpDataCache({ workspaces: [{ id: 'ws', name: 'Fixture' }], servers: [{ id: 'device', workspaceId: 'ws', name: 'Fixture', host: '127.0.0.1', port: transport === 'ssh' ? sshPort : tcpPort, auth: 'password', username: 'fixture', route: [], tags: ['transport:' + transport, ...(compatibility ? ['ssh-compat:' + compatibility] : []), 'encoding:' + wireEncoding] }] })
}
function config(extra = {}): any { return { sessionId: 'native-fixture', serverId: 'device', host: '127.0.0.1', port: tcpPort, auth: 'password', username: 'fixture', cols: 100, rows: 30, ...extra } }
function contents(w: WindowFixture): WebContents { return w as unknown as WebContents }
beforeAll(async () => {
  setSecret('device', JSON.stringify({ password: 'synthetic-password' }))
  tcp = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket))
    let buffer = '', phase = 0; const codec = new TelnetCodec(), decoder = terminalDecoder(wireEncoding); const encoding = wireEncoding
    socket.write(Buffer.from([255, 253, 31, 255, 253, 24])); socket.write(encodeTerminal(chineseLogin ? '用户名：' : 'Username: ', encoding))
    socket.on('data', b => {
      control.push(b); buffer += decoder.write(codec.decode(b).data)
      let at: number
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).replace(/\r/g, ''); buffer = buffer.slice(at + 1); lines.push(line)
        if (phase++ === 0) socket.write(encodeTerminal(chineseLogin ? '密码：' : 'Password: ', encoding))
        else if (phase === 2) { if (rejectPassword || line !== expectedPassword) socket.end('Login incorrect\r\nUsername: '); else socket.write('\r\n<Fixture>') }
        else { const output = encodeTerminal(line + '\r\n华为终端\r\n<Fixture>', encoding); for (const byte of output) socket.write(Buffer.from([byte])) }
      }
    })
  })
  await new Promise<void>(r => tcp.listen(0, '127.0.0.1', r)); tcpPort = (tcp.address() as { port: number }).port
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey
  ssh = new SshServer({ hostKeys: [key], algorithms: { kex: ['diffie-hellman-group14-sha1'] } }, c => {
    sshClients.push(c); c.on('error', () => {}); c.on('authentication', ctx => ctx.accept())
    c.on('ready', () => c.on('session', accept => {
      const s = accept(); s.on('pty', yes => yes?.())
      s.on('shell', yes => {
        const channel = yes(), encoding = wireEncoding, decoder = terminalDecoder(encoding)
        channel.write('<WeakFixture>')
        channel.on('data', (b: Buffer) => { const text = decoder.write(b); lines.push(text); const out = encodeTerminal('华为终端' + text, encoding); channel.write(out.subarray(0, 1)); setTimeout(() => channel.write(out.subarray(1)), 5) })
      })
      s.on('exec', (yes, _no, _info) => {
        const channel = yes(), out = encodeTerminal('华为终端', wireEncoding)
        channel.write(out.subarray(0, 1)); channel.stderr.write(out.subarray(0, 1))
        setTimeout(() => { channel.write(out.subarray(1)); channel.stderr.write(out.subarray(1)); channel.exit(0); channel.end() }, 5)
      })
    }))
  })
  await new Promise<void>(r => ssh.listen(0, '127.0.0.1', r)); sshPort = (ssh.address() as { port: number }).port
  const parsed = utils.parseKey(key); if (parsed instanceof Error) throw parsed
  writeFileSync(join(app.getPath('userData'), 'opsmaxx-known-hosts.json'), JSON.stringify({ [`127.0.0.1:${sshPort}`]: { id: `127.0.0.1:${sshPort}`, fingerprint: fingerprint(parsed.getPublicSSH()), addedAt: new Date().toISOString() } }))
})
afterEach(() => { vi.useRealTimers(); closeNativeNetworkTerminals(); sshClose('native-fixture'); poolDisposeAll(); lines.length = 0; control.length = 0; rejectPassword = false; wireEncoding = 'utf8'; chineseLogin = false; expectedPassword = 'synthetic-password' })
afterAll(async () => { for (const s of sockets) s.destroy(); for (const c of sshClients) c.end(); await Promise.all([new Promise<void>(r => tcp.close(() => r())), new Promise<void>(r => ssh.close(() => r()))]) })

describe('actual native window transport paths', () => {
  it('opens saved Telnet as a terminal, forwards input/output and resize, isolates its owner and closes cleanly', async () => {
    cache('telnet'); const w = new WindowFixture(); await nativeNetworkConnect(contents(w), config())
    expect(w.messages.some(m => m.value.phase === 'ready')).toBe(true)
    expect(lines).toEqual(['fixture', 'synthetic-password'])
    const other = new WindowFixture(); other.id = 2
    nativeTelnetWrite(contents(other), 'native-fixture', 'wrong-owner\r'); nativeTelnetClose(contents(other), 'native-fixture')
    expect(nativeTelnetOwns('native-fixture')).toBe(true)
    nativeTelnetResize(contents(w), 'native-fixture', 120, 40)
    nativeTelnetWrite(contents(w), 'native-fixture', 'display version\r')
    await vi.waitFor(() => expect(w.messages.map(m => typeof m.value === 'string' ? m.value : '').join('')).toContain('华为终端'))
    expect(lines).toEqual(['fixture', 'synthetic-password', 'display version'])
    expect(Buffer.concat(control).includes(Buffer.from([255, 250, 31, 0, 120, 0, 40, 255, 240]))).toBe(true)
    expect(JSON.stringify(w.messages)).not.toContain('synthetic-password')
    // A human terminal has a login deadline, not the bounded MCP operation lifetime.
    vi.useFakeTimers(); vi.advanceTimersByTime(120_000); expect(nativeTelnetOwns('native-fixture')).toBe(true); vi.useRealTimers()
    nativeTelnetClose(contents(w), 'native-fixture'); expect(nativeTelnetOwns('native-fixture')).toBe(false)
  })
  it('round-trips GBK Telnet bytes, Chinese login prompts and credentials without substitutions', async () => {
    wireEncoding = 'gbk'; chineseLogin = true; expectedPassword = '测试口令'; cache('telnet')
    const w = new WindowFixture()
    await nativeNetworkConnect(contents(w), config({ serverId: undefined, username: '测试用户', password: expectedPassword, terminalEncoding: 'gbk', remoteTransport: 'telnet' }))
    expect(w.messages.some(m => m.value.phase === 'ready')).toBe(true)
    nativeTelnetWrite(contents(w), 'native-fixture', 'description 领益机房\r')
    await vi.waitFor(() => expect(w.messages.map(m => typeof m.value === 'string' ? m.value : '').join('')).toContain('领益机房'))
    expect(lines).toEqual(['测试用户', expectedPassword, 'description 领益机房'])
    expect(JSON.stringify(w.messages)).not.toContain(expectedPassword)
    const before = lines.length
    nativeTelnetWrite(contents(w), 'native-fixture', 'description 😀\r')
    expect(w.messages.at(-1)?.value.message).toContain('cannot be represented')
    await new Promise(r => setTimeout(r, 20)); expect(lines).toHaveLength(before)
  })
  it.each(['utf8', 'gbk'] as const)('keeps split native SSH, exec and streaming stderr separate in %s', async encoding => {
    wireEncoding = encoding; cache('ssh', 'huawei-sha1')
    const cfg = config({ port: sshPort, terminalEncoding: encoding, sshCompatibility: 'huawei-sha1' })
    const w = new WindowFixture(); await nativeNetworkConnect(contents(w), cfg)
    await vi.waitFor(() => expect(w.messages.some(m => m.value.phase === 'ready')).toBe(true))
    sshWrite('native-fixture', 'description 领益机房\r')
    await vi.waitFor(() => expect(w.messages.map(m => typeof m.value === 'string' ? m.value : '').join('')).toContain('华为终端description 领益机房'))
    expect(lines).toContain('description 领益机房\r')
    const result = await sshExec(cfg, 'display version')
    expect(result.stdout).toBe('华为终端'); expect(result.stderr).toBe('华为终端')
    let stdout = '', stderr = ''
    await new Promise<void>((resolve, reject) => { void sshExecStream(cfg, 'display version', { onStdout: c => { stdout += c }, onStderr: c => { stderr += c }, onClose: () => resolve(), onError: e => reject(new Error(e)) }).catch(reject) })
    expect(stdout).toBe('华为终端'); expect(stderr).toBe('华为终端')
  })
  it('tests Telnet authentication without running a device command and refuses a rejected credential once', async () => {
    cache('telnet'); expect(await nativeNetworkTest(config())).toEqual({ ok: true }); expect(lines).toEqual(['fixture', 'synthetic-password'])
    lines.length = 0; rejectPassword = true; expect((await nativeNetworkTest(config())).ok).toBe(false); expect(lines).toEqual(['fixture', 'synthetic-password'])
  })
  it('honors a form protocol selection before saving and releases a destroyed window', async () => {
    cache('ssh'); expect(await nativeNetworkTest(config({ remoteTransport: 'telnet' }))).toEqual({ ok: true })
    const w = new WindowFixture(); await nativeNetworkConnect(contents(w), config({ remoteTransport: 'telnet' })); w.destroyed = true; w.emit('destroyed'); expect(nativeTelnetOwns('native-fixture')).toBe(false)
  })
  it('resolves the saved Huawei compatibility policy on the native SSH entry; an explicit strict edit still fails', async () => {
    cache('ssh', 'huawei-sha1'); const cfg = config({ port: sshPort })
    expect((await nativeNetworkTest(cfg)).ok).toBe(true)
    expect((await nativeNetworkTest({ ...cfg, sshCompatibility: 'strict' })).ok).toBe(false)
    const w = new WindowFixture(); await nativeNetworkConnect(contents(w), cfg)
    await vi.waitFor(() => expect(w.messages.some(m => m.value.phase === 'ready')).toBe(true))
    await vi.waitFor(() => expect(w.messages.some(m => typeof m.value === 'string' && m.value.includes('<WeakFixture>'))).toBe(true))
  })
  it('uses full global compatibility for multiple untagged devices with Group1/CBC/MD5 and preserves explicit strict refusal', async () => {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey
    const negotiated: any[] = []
    const target = new SshServer({ hostKeys: [key], algorithms: { kex: ['diffie-hellman-group1-sha1'], serverHostKey: ['ssh-rsa'], cipher: ['aes128-cbc'], hmac: ['hmac-md5'] } }, c => {
      sshClients.push(c); c.on('error', () => {}); c.on('handshake', n => negotiated.push(n)); c.on('authentication', ctx => ctx.accept())
      c.on('ready', () => c.on('session', accept => { const s = accept(); s.on('pty', yes => yes?.()); s.on('shell', yes => yes().write('<FullLegacy>')) }))
    })
    await new Promise<void>(r => target.listen(0, '127.0.0.1', r)); const port = (target.address() as { port: number }).port
    const parsed = utils.parseKey(key); if (parsed instanceof Error) throw parsed
    const knownPath = join(app.getPath('userData'), 'opsmaxx-known-hosts.json')
    writeFileSync(knownPath, JSON.stringify({ ...JSON.parse(readFileSync(knownPath, 'utf8')), [`127.0.0.1:${port}`]: { id: `127.0.0.1:${port}`, fingerprint: fingerprint(parsed.getPublicSSH()), addedAt: new Date().toISOString() } }))
    refreshMcpDataCache({ settings: { sshCompatibilityDefault: 'huawei-legacy' }, servers: ['global-a', 'global-b'].map(id => ({ id, workspaceId: 'ws', name: id, host: '127.0.0.1', port, username: 'fixture', auth: 'password', route: [], tags: [] })) })
    try {
      for (const serverId of ['global-a', 'global-b']) {
        setSecret(serverId, JSON.stringify({ password: 'synthetic-password' }))
        expect((await nativeNetworkTest(config({ serverId, port }))).ok).toBe(true)
      }
      expect((await nativeNetworkTest(config({ serverId: 'global-a', port, sshCompatibility: 'strict' }))).ok).toBe(false)
      const w = new WindowFixture(); await nativeNetworkConnect(contents(w), config({ serverId: 'global-b', port }))
      await vi.waitFor(() => expect(w.messages.some(m => typeof m.value === 'string' && m.value.includes('<FullLegacy>'))).toBe(true))
      expect(negotiated).toHaveLength(3)
      for (const n of negotiated) expect(n).toMatchObject({ kex: 'diffie-hellman-group1-sha1', serverHostKey: 'ssh-rsa', cs: { cipher: 'aes128-cbc', mac: 'hmac-md5' } })
    } finally {
      sshClose('native-fixture'); poolDisposeAll(); refreshMcpDataCache({}); for (const c of sshClients) c.end(); await new Promise<void>(r => target.close(() => r()))
    }
  })

})
