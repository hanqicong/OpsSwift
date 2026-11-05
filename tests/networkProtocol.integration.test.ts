import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect as tcpConnect } from 'node:net'
import { app } from 'electron'
import { Client as SshClient, Server as SshServer, utils } from 'ssh2'
import type { ConnectConfig, ServerConfig } from 'ssh2'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { fingerprint } from '../src/main/services/knownhosts'
import { openChain, poolDisposeAll } from '../src/main/services/ssh'
import { withLegacySshRetry } from '../src/main/services/sshCompatibility'
import { refreshMcpDataCache } from '../src/main/services/mcpDataCache'
import { setAssignment, resetPolicyCacheForTests } from '../src/main/services/policyStore'
import { setMcpConfig, createSession, resetMcpAuthForTests } from '../src/main/services/mcpAuth'
import { onApprovalEvent, respondToApproval, resetApprovalVolumeForTests } from '../src/main/services/approvals'
import { startMcpServer, stopMcpServer } from '../src/main/services/mcpServer'

const PORT = 18799
let hostKey: string
let target: SshServer
let targetPort: number
let targetKey: Buffer
let description = 'Before'
let rejectConfiguration = false
let dropConfiguration = false
const received: string[] = []
let approvedCount = 0
let answer: 'approved' | 'denied' = 'approved'
let unsubscribe: () => void
const clients: SshClient[] = []

async function listening(server: SshServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}
function config(): string { return `#\ninterface GE1/0/1\n description ${description}\n#\nreturn` }
function record(): object { return { id: 'device', workspaceId: 'ws', name: 'Network fixture', host: '127.0.0.1', port: targetPort, username: 'fixture', auth: 'password', rev: 1, os: 'Network', route: [], tags: ['network:huawei_vrp', 'network:configure'] } }
function cache(server = record()): void { refreshMcpDataCache({ workspaces: [{ id: 'ws', name: 'Network lab' }], servers: [server] }) }
async function mcp(mode: 'bypass' | 'readOnly' = 'bypass'): Promise<Client> {
  const created = createSession({ agentName: 'network-test', workspaces: [{ id: 'ws', name: 'Network lab' }], groupId: mode === 'bypass' ? 'grp-full-access' : 'grp-read-only', groupName: mode, mode, ttlMinutes: 60 })
  const client = new Client({ name: 'network-fixture', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${created.token}` } } }))
  return client
}
function body(r: unknown): string { return ((r as { content: { text: string }[] }).content ?? []).map((x) => x.text ?? '').join('\n') }
function data(r: unknown): any { const s = body(r); return JSON.parse(s.slice(s.indexOf('{'))) }
async function plan(client: Client, value = 'After'): Promise<{ planId: string; planHash: string }> {
  const response = await client.callTool({ name: 'network_plan_change', arguments: { serverName: 'Network fixture', changes: [{ kind: 'interface_description', target: 'GE1/0/1', value }], persist: false } })
  return data(response)
}
beforeAll(async () => {
  hostKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey
  const parsed = utils.parseKey(hostKey)
  if (parsed instanceof Error) throw parsed
  targetKey = parsed.getPublicSSH()
  target = new SshServer({ hostKeys: [hostKey] }, (connection) => {
    connection.on('error', () => {})
    connection.on('authentication', (ctx) => ctx.accept())
    connection.on('ready', () => connection.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => acceptPty?.())
      session.on('shell', (acceptShell) => {
        const channel = acceptShell(); let input = ''; let mode = '<Fixture>'
        channel.write(mode)
        channel.on('data', (chunk: Buffer) => {
          input += chunk.toString()
          let at: number
          while ((at = input.indexOf('\r')) >= 0) {
            const command = input.slice(0, at); input = input.slice(at + 1); received.push(command)
            let out = ''
            if (command === 'display version') out = 'Huawei VRP fixture V200'
            else if (command === 'display current-configuration') out = config()
            else if (command === 'system-view') mode = '[Fixture]'
            else if (command.startsWith('interface ')) mode = '[Fixture-GE1/0/1]'
            else if (command.startsWith('description ')) {
              if (rejectConfiguration) out = 'Error: fixture rejected command'
              else if (!dropConfiguration) description = command.slice(12)
            } else if (command === 'return') mode = '<Fixture>'
            else if (command === 'quit') mode = '[Fixture]'
            channel.write(command + '\r\n' + (out ? out + '\r\n' : '') + mode)
          }
        })
      })
    }))
  })
  targetPort = await listening(target)
  writeFileSync(join(app.getPath('userData'), 'opsmaxx-known-hosts.json'), JSON.stringify({ [`127.0.0.1:${targetPort}`]: { id: `127.0.0.1:${targetPort}`, fingerprint: fingerprint(targetKey), addedAt: new Date().toISOString() } }))
  resetMcpAuthForTests(); resetPolicyCacheForTests(); cache()
  setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full-access')
  setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
  unsubscribe = onApprovalEvent((event) => {
    if (event.type === 'created') { approvedCount++; setImmediate(() => respondToApproval(event.request.id, answer)) }
  })
  expect((await startMcpServer()).ok).toBe(true)
}, 30000)
beforeEach(() => { poolDisposeAll(); cache(); description = 'Before'; rejectConfiguration = false; dropConfiguration = false; received.length = 0; approvedCount = 0; answer = 'approved'; resetApprovalVolumeForTests() })
afterAll(async () => { unsubscribe(); await stopMcpServer(); poolDisposeAll(); for (const c of clients) c.destroy(); await new Promise<void>((resolve) => target.close(() => resolve())) })

describe('real SSH device through authenticated MCP', () => {
  it('reads complete state over a real shell and does not configure', async () => {
    const client = await mcp(); const response = await client.callTool({ name: 'network_get_state', arguments: { serverName: 'Network fixture', query: 'version' } }); expect(data(response).output).toContain('Huawei VRP'); expect(received).toEqual(['screen-length 0 temporary', 'display version']); await client.close()
  })
  it('plans without writing, applies only after approval, backs up and verifies readback', async () => {
    const client = await mcp(); const p = await plan(client); expect(received).not.toContain('system-view'); expect(description).toBe('Before')
    const response = await client.callTool({ name: 'network_apply_change', arguments: { serverName: 'Network fixture', ...p } }); expect(data(response).status).toBe('applied_and_readback_verified'); expect(data(response).backup.encrypted).toBe(true); expect(description).toBe('After'); expect(approvedCount).toBe(1)
    const replay = await client.callTool({ name: 'network_apply_change', arguments: { serverName: 'Network fixture', ...p } }); expect(replay.isError).toBe(true)
    const verify = await client.callTool({ name: 'network_verify_change', arguments: { serverName: 'Network fixture', ...p } }); expect(data(verify).checks[0].matched).toBe(true); await client.close()
  })
  it('refuses baseline drift before any configuration command', async () => {
    const client = await mcp(); const p = await plan(client); description = 'Changed elsewhere'; received.length = 0
    expect((await client.callTool({ name: 'network_apply_change', arguments: { serverName: 'Network fixture', ...p } })).isError).toBe(true); expect(received).not.toContain('system-view'); expect(description).toBe('Changed elsewhere'); await client.close()
  })
  it('does not consume or execute a denied plan', async () => {
    const client = await mcp(); const p = await plan(client); received.length = 0; answer = 'denied'
    expect((await client.callTool({ name: 'network_apply_change', arguments: { serverName: 'Network fixture', ...p } })).isError).toBe(true); expect(received).toHaveLength(0); expect(description).toBe('Before'); await client.close()
  })
  it('allows read-only planning but refuses application before any configuration connection', async () => {
    const client = await mcp('readOnly'); const p = await plan(client); expect(received).not.toContain('system-view'); received.length = 0
    const r = await client.callTool({ name: 'network_apply_change', arguments: { serverName: 'Network fixture', ...p } }); expect(r.isError).toBe(true); expect(received).toHaveLength(0); await client.close()
  })
  it('does not let an MCP caller configure an unassigned server', async () => {
    cache({ ...(record() as object), tags: [] }); const client = await mcp(); const r = await client.callTool({ name: 'network_get_state', arguments: { serverName: 'Network fixture', query: 'version' } }); expect(r.isError).toBe(true); expect(received).toHaveLength(0); await client.close()
  })
  it('invalidates plans after a connection revision or profile changes', async () => {
    const client = await mcp(); const p = await plan(client); cache({ ...(record() as object), rev: 2 }); received.length = 0
    expect((await client.callTool({ name: 'network_apply_change', arguments: { serverName: 'Network fixture', ...p } })).isError).toBe(true); expect(received).toHaveLength(0); await client.close()
  })
  it('stops at a rejected mutation and never replays the partial transaction', async () => {
    const client = await mcp(); const p = await plan(client); rejectConfiguration = true
    const failed = await client.callTool({ name: 'network_apply_change', arguments: { serverName: 'Network fixture', ...p } }); expect(failed.isError).toBe(true); expect(body(failed)).toContain('partially applied'); received.length = 0
    expect((await client.callTool({ name: 'network_apply_change', arguments: { serverName: 'Network fixture', ...p } })).isError).toBe(true); expect(received).toHaveLength(0); await client.close()
  })
  it('does not save an unverified change and returns a tool error on readback mismatch', async () => {
    const client = await mcp()
    const p = data(await client.callTool({ name: 'network_plan_change', arguments: { serverName: 'Network fixture', changes: [{ kind: 'interface_description', target: 'GE1/0/1', value: 'Ignored' }], persist: true } }))
    dropConfiguration = true
    const result = await client.callTool({ name: 'network_apply_change', arguments: { serverName: 'Network fixture', planId: p.planId, planHash: p.planHash } })
    expect(result.isError).toBe(true); expect(data(result).status).toBe('applied_readback_mismatch'); expect(received).not.toContain('save'); await client.close()
  })
})

describe('real legacy SSH algorithm negotiation', () => {
  async function fixture(algorithms: ServerConfig['algorithms']): Promise<{ server: SshServer; port: number }> {
    const server = new SshServer({ hostKeys: [hostKey], algorithms }, (conn) => { conn.on('error', () => {}); conn.on('authentication', (ctx) => ctx.accept()) }); return { server, port: await listening(server) }
  }
  async function dial(port: number, algorithms: ConnectConfig['algorithms'], verify = true): Promise<SshClient> {
    return new Promise((resolve, reject) => { const client = new SshClient(); clients.push(client); client.on('error', (e) => { client.destroy(); reject(e) }); client.on('ready', () => resolve(client)); client.connect({ host: '127.0.0.1', port, username: 'fixture', algorithms, hostVerifier: () => verify, readyTimeout: 3000 }) })
  }
  it('can reach a group14-sha1-only endpoint while strict mode refuses', async () => {
    const f = await fixture({ kex: ['diffie-hellman-group14-sha1'] }); try {
      await expect(withLegacySshRetry('strict', (a) => dial(f.port, a))).rejects.toThrow('no matching key exchange')
      const client = await withLegacySshRetry('huawei-sha1', (a) => dial(f.port, a)); client.destroy()
    } finally { await new Promise<void>((r) => f.server.close(() => r())) }
  })
  it('supports explicitly selected Group1 plus CBC and SHA-1 MAC', async () => {
    const f = await fixture({ kex: ['diffie-hellman-group1-sha1'], cipher: ['aes128-cbc'], hmac: ['hmac-sha1-96'] }); try {
      await expect(withLegacySshRetry('huawei-sha1', (a) => dial(f.port, a))).rejects.toThrow()
      const client = await withLegacySshRetry('huawei-legacy', (a) => dial(f.port, a)); client.destroy()
    } finally { await new Promise<void>((r) => f.server.close(() => r())) }
  })
  it('still refuses an untrusted key after legacy KEX negotiation', async () => {
    const f = await fixture({ kex: ['diffie-hellman-group14-sha1'] }); try { await expect(withLegacySshRetry('huawei-sha1', (a) => dial(f.port, a, false))).rejects.toThrow('verification failed') } finally { await new Promise<void>((r) => f.server.close(() => r())) }
  })
  it('opens fresh jump channels on algorithm fallback using the real OpsSwift chain', async () => {
    const f = await fixture({ kex: ['diffie-hellman-group14-sha1'] }); let forwards = 0
    const bastion = new SshServer({ hostKeys: [hostKey] }, (conn) => { conn.on('error', () => {}); conn.on('authentication', (ctx) => ctx.accept()); conn.on('ready', () => conn.on('tcpip', (accept, reject, info) => { const socket = tcpConnect(info.destPort, info.destIP, () => { forwards++; const channel = accept(); channel.pipe(socket).pipe(channel) }); socket.on('error', () => reject()) })) })
    const port = await listening(bastion)
    const entries = [port, f.port, targetPort].map((p) => [`127.0.0.1:${p}`, { id: `127.0.0.1:${p}`, fingerprint: fingerprint(targetKey), addedAt: new Date().toISOString() }])
    writeFileSync(join(app.getPath('userData'), 'opsmaxx-known-hosts.json'), JSON.stringify(Object.fromEntries(entries)))
    try {
      const hop = { host: '127.0.0.1', port, username: 'fixture', auth: 'password' as const }
      const chain = await openChain({ ...hop, port: f.port, sshCompatibility: 'huawei-sha1', hops: [hop] }, undefined, false)
      expect(forwards).toBe(2); for (const c of chain.clients) c.destroy()
    } finally { await new Promise<void>((r) => bastion.close(() => r())); await new Promise<void>((r) => f.server.close(() => r())) }
  })
})
