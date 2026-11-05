import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { Server as SshServer, utils } from 'ssh2'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { fingerprint } from '../src/main/services/knownhosts'
import { poolDisposeAll } from '../src/main/services/ssh'
import { terminalDecoder, encodeTerminal } from '../src/main/services/terminalCodec'
import { refreshMcpDataCache } from '../src/main/services/mcpDataCache'
import { setAssignment, resetPolicyCacheForTests } from '../src/main/services/policyStore'
import { setMcpConfig, createSession, resetMcpAuthForTests } from '../src/main/services/mcpAuth'
import { onApprovalEvent, respondToApproval, resetApprovalVolumeForTests } from '../src/main/services/approvals'
import { startMcpServer, stopMcpServer } from '../src/main/services/mcpServer'
const PORT = 18817
let target: SshServer, port: number, unsubscribe: () => void
let standby = false, firmware = 'V500R005C20SPC500', dropAction = false, deny = false, approvals = 0
const received: string[] = [], connections: Array<{ end: () => void }> = []
const objects = new Map<string, string[]>(), security = new Map<string, string[]>(), nat = new Map<string, string[]>()
function config(): string {
  const sets = [...objects].map(([n, lines]) => `ip address-set ${n} type object\n${lines.map(l => ' ' + l).join('\n')}\n#`).join('\n')
  const rules = (p: string, map: Map<string, string[]>): string => `${p}\n default action deny\n${[...map].map(([n, ls]) => ` rule name ${n}\n${ls.map(l => '  ' + l).join('\n')}`).join('\n')}\n#`
  return `#\nhrp enable\n#\n${sets}\n${rules('security-policy', security)}\n${rules('nat-policy', nat)}\naaa\n password cipher SYNTHETIC-PRIVATE-CONFIG\n#\nreturn`
}
function cache(): void { refreshMcpDataCache({ workspaces: [{ id: 'ws', name: 'USG lab' }], servers: [{ id: 'usg', workspaceId: 'ws', name: 'USG fixture', host: '127.0.0.1', port, username: 'fixture', auth: 'password', rev: 1, route: [], tags: ['network:huawei_usg', 'network:configure', 'encoding:gbk'] }] }) }
async function mcp(): Promise<Client> {
  const session = createSession({ agentName: 'usg-test', workspaces: [{ id: 'ws', name: 'USG lab' }], groupId: 'grp-full-access', groupName: 'full', mode: 'bypass', ttlMinutes: 60 })
  const client = new Client({ name: 'usg-fixture', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${session.token}` } } }))
  return client
}
function body(r: any): string { return r.content.map((c: any) => c.text ?? '').join('\n') }
function data(r: any): any { const text = body(r); return JSON.parse(text.slice(text.indexOf('{'))) }
const changes = [
  { kind: 'usg_address_set', target: '应用服务器', addresses: ['198.51.100.8/32'], description: '领益应用' },
  { kind: 'usg_security_rule', target: '业务HTTPS', sourceZone: 'trust', destinationZone: 'untrust', sourceAddressSet: '内网', destinationAddressSet: '应用服务器', service: 'https', action: 'permit' },
  { kind: 'usg_nat_rule', target: '业务NAT', sourceZone: 'trust', destinationZone: 'untrust', sourceAddressSet: '内网', destinationAddressSet: '应用服务器', translation: 'easy-ip' }
]
async function plan(client: Client): Promise<any> { return data(await client.callTool({ name: 'network_plan_change', arguments: { serverName: 'USG fixture', changes, persist: true } })) }
async function apply(client: Client, p: any): Promise<any> { return client.callTool({ name: 'network_apply_change', arguments: { serverName: 'USG fixture', planId: p.planId, planHash: p.planHash } }) }
beforeAll(async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey
  target = new SshServer({ hostKeys: [key] }, connection => {
    connections.push(connection); connection.on('error', () => {}); connection.on('authentication', c => c.accept())
    connection.on('ready', () => connection.on('session', accept => {
      const session = accept(); session.on('pty', yes => yes?.())
      session.on('shell', yes => {
        const channel = yes(), decoder = terminalDecoder('gbk'); let input = '', view = '', current: string[] | undefined
        const prompt = (): string => `HRP_${standby ? 'S' : 'M'}${view ? '[USG-' + view + ']' : '<USG>'}`
        const send = (text: string): void => { const b = encodeTerminal(text, 'gbk'); channel.write(b.subarray(0, 1)); setTimeout(() => { if (!channel.destroyed) channel.write(b.subarray(1)) }, 2) }
        send(prompt())
        channel.on('data', (b: Buffer) => {
          input += decoder.write(b); let at: number
          while ((at = input.indexOf('\r')) >= 0) {
            const command = input.slice(0, at); input = input.slice(at + 1); received.push(command); let out = ''
            if (command === 'display version') out = `Huawei VRP (R) Software, Version 5.170 (USG6600 ${firmware})\n领益防火墙`
            else if (command === 'display current-configuration') out = config()
            else if (command === 'display hrp state') out = standby ? 'Role: standby, peer: active' : 'Role: active, peer: standby'
            else if (command.startsWith('display ')) out = '只读诊断结果'
            else if (command === 'system-view') view = 'system'
            else if (command.startsWith('ip address-set ')) { const name = command.split(' ')[2]; current = []; objects.set(name, current); view = 'address' }
            else if (command === 'security-policy' || command === 'nat-policy') { view = command; current = undefined }
            else if (command.startsWith('rule name ')) { current = []; (view === 'security-policy' ? security : nat).set(command.slice(10), current) }
            else if (command === 'quit') { current = undefined; if (!['security-policy', 'nat-policy'].includes(view)) view = 'system' }
            else if (command === 'return') { view = ''; current = undefined }
            else if (current && !(dropAction && command.startsWith('action '))) current.push(command)
            send(command + '\r\n' + (out ? out + '\r\n' : '') + prompt())
          }
        })
      })
    }))
  })
  await new Promise<void>(r => target.listen(0, '127.0.0.1', r)); port = (target.address() as { port: number }).port
  const parsed = utils.parseKey(key); if (parsed instanceof Error) throw parsed
  writeFileSync(join(app.getPath('userData'), 'opsmaxx-known-hosts.json'), JSON.stringify({ [`127.0.0.1:${port}`]: { id: `127.0.0.1:${port}`, fingerprint: fingerprint(parsed.getPublicSSH()), addedAt: new Date().toISOString() } }))
  resetMcpAuthForTests(); resetPolicyCacheForTests(); cache(); setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full-access')
  setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
  unsubscribe = onApprovalEvent(e => { if (e.type === 'created') { approvals++; setImmediate(() => respondToApproval(e.request.id, deny ? 'denied' : 'approved')) } })
  expect((await startMcpServer()).ok).toBe(true)
}, 30000)
beforeEach(() => {
  poolDisposeAll(); standby = false; firmware = 'V500R005C20SPC500'; deny = false; dropAction = false; approvals = 0; received.length = 0; resetApprovalVolumeForTests()
  objects.clear(); security.clear(); nat.clear(); objects.set('内网', ['address 0 10.20.0.0 mask 24']); objects.set('外部', ['address 0 192.0.2.0 mask 24']); cache()
})
afterAll(async () => { unsubscribe(); await stopMcpServer(); poolDisposeAll(); connections.forEach(c => c.end()); await new Promise<void>(r => target.close(() => r())) })
describe('USG GBK shell through authenticated MCP', () => {
  it('advertises bounded capabilities and reads Chinese inventory without unrelated secrets', async () => {
    const client = await mcp()
    const caps = data(await client.callTool({ name: 'network_get_capabilities', arguments: { serverName: 'USG fixture' } }))
    expect(caps.terminalEncoding).toBe('gbk'); expect(caps.changes).toContain('usg_nat_rule'); expect(caps.queries).toContain('ipsec_sa')
    const result = await client.callTool({ name: 'network_get_state', arguments: { serverName: 'USG fixture', query: 'address_objects' } })
    expect(data(result).objects[0].name).toBe('内网'); expect(body(result)).not.toContain('SYNTHETIC-PRIVATE-CONFIG')
    expect(received).not.toContain('system-view'); await client.close()
  })
  it('plans without mutation, approves exact commands, encrypts Chinese baseline, verifies and saves', async () => {
    const client = await mcp(), p = await plan(client)
    expect(received).not.toContain('system-view'); expect(p.commands).toContain('action source-nat easy-ip'); expect(p.rulePlacement).toContain('shadow')
    const result = data(await apply(client, p)); expect(result.status).toBe('applied_and_readback_verified'); expect(approvals).toBe(1); expect(received).toContain('save')
    const envelope = JSON.parse(readFileSync(join(app.getPath('userData'), 'network-backups', `${result.backup.id}.json`), 'utf8'))
    expect(safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64'))).toContain('ip address-set 内网')
    expect((await apply(client, p)).isError).toBe(true)
    const verified = data(await client.callTool({ name: 'network_verify_change', arguments: { serverName: 'USG fixture', planId: p.planId, planHash: p.planHash } }))
    expect(verified.checks.every((c: any) => c.matched)).toBe(true); await client.close()
  })
  it('refuses standby planning and rechecks HA after approval before any config write', async () => {
    const client = await mcp(); standby = true
    const refusal = await client.callTool({ name: 'network_plan_change', arguments: { serverName: 'USG fixture', changes } })
    expect(refusal.isError).toBe(true); expect(body(refusal)).toContain('standby'); expect(received).not.toContain('system-view')
    standby = false; const p = await plan(client); standby = true; received.length = 0
    expect((await apply(client, p)).isError).toBe(true); expect(received).not.toContain('system-view'); await client.close()
  })
  it('refuses unsupported firmware and existing rules with useful nonsecret feedback', async () => {
    const client = await mcp(); firmware = 'V600R007C20'
    let result = await client.callTool({ name: 'network_plan_change', arguments: { serverName: 'USG fixture', changes } })
    expect(result.isError).toBe(true); expect(body(result)).toContain('V500R005')
    firmware = 'V500R005C20SPC500'; security.set('业务HTTPS', ['action deny'])
    result = await client.callTool({ name: 'network_plan_change', arguments: { serverName: 'USG fixture', changes } })
    expect(result.isError).toBe(true); expect(body(result)).toContain('already exists'); expect(received).not.toContain('system-view'); await client.close()
  })
  it('does not connect for denied application, including its denial cooldown', async () => {
    const client = await mcp(), p = await plan(client); received.length = 0; deny = true
    expect((await apply(client, p)).isError).toBe(true); expect(received).toHaveLength(0)
    deny = false
    expect((await apply(client, p)).isError).toBe(true); expect(received).toHaveLength(0); expect(approvals).toBe(1); await client.close()
  })
  it('never saves or replays a partial readback mismatch', async () => {
    const client = await mcp(), p = await plan(client); dropAction = true
    const result = await apply(client, p); expect(result.isError).toBe(true); expect(data(result).status).toBe('applied_readback_mismatch'); expect(received).not.toContain('save')
    received.length = 0; expect((await apply(client, p)).isError).toBe(true); expect(received).toHaveLength(0); await client.close()
  })
})
