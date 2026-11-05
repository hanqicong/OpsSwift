import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer as createTcpServer, connect as tcpConnect, type Server as TcpServer, type Socket } from 'node:net'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import * as tls from 'node:tls'
import { createHmac, generateKeyPairSync, timingSafeEqual } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import { app } from 'electron'
import { Server as SshServer, utils } from 'ssh2'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { NetconfFramer, netconfFrame, NETCONF_NS } from '../src/main/services/protocolNetconf'
import { TelnetCodec } from '../src/main/services/protocolTelnet'
import { parseXml, descendants, xmlEscape, boundedProtocol, openProtocolSocket } from '../src/main/services/protocolWire'
import { callJsonRpc } from '../src/main/services/protocolJsonRpc'
import { fingerprint } from '../src/main/services/knownhosts'
import { setSecret } from '../src/main/services/secrets'
import { poolDisposeAll } from '../src/main/services/ssh'
import { refreshMcpDataCache } from '../src/main/services/mcpDataCache'
import { resetPolicyCacheForTests, setAssignment } from '../src/main/services/policyStore'
import { createSession, resetMcpAuthForTests, setMcpConfig } from '../src/main/services/mcpAuth'
import { onApprovalEvent, resetApprovalVolumeForTests, respondToApproval } from '../src/main/services/approvals'
import { startMcpServer, stopMcpServer } from '../src/main/services/mcpServer'

const PORT = 18803
const PASSWORD = 'synthetic-protocol-password'
const cert = readFileSync(resolve('tests/fixtures/remote-protocols/localhost-cert.pem'), 'utf8')
const key = readFileSync(resolve('tests/fixtures/remote-protocols/localhost-key.pem'), 'utf8')
// Node's test process trusts ONLY this synthetic CA in addition to its normal roots. No application bypass exists.
const caApi = tls as unknown as { getCACertificates: (type: string) => string[]; setDefaultCACertificates: (certs: string[]) => void }
let originalRoots: string[]
const md4 = createRequire(import.meta.url)('@ewsjs/ntlm-client/lib/hash') as { createNTLMHash: (password: string) => Buffer }
let telnet: TcpServer, https: HttpsServer, ssh: SshServer
let telnetPort: number, httpsPort: number, sshPort: number
const sockets = new Set<Duplex>()
const sshClients: Array<{ end: () => void }> = []
const clients: Client[] = []
const commands: string[] = []
const telnetLines: string[] = []
const rpcRequests: string[] = []
const soapActions: string[] = []
const scripts: string[] = []
let approvals: string[] = []
let answer: 'approved' | 'denied' = 'approved'
let approvalEdit: (() => void) | undefined
let unsubscribe: () => void
let rpcError = false, badId = false, receiveTimeout = false, badPassword = false, ntlmV1 = false, deleteFailure = false
let exitCode = 0
let jsonCount = 0, connections = 0, type3Count = 0
let base11 = true
let telnetDescription = 'Fixture'
let revokeOnHttpsConnect = false
function keep(socket: Duplex): void { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)) }
async function listening(server: TcpServer | HttpsServer | SshServer): Promise<number> { await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); return (server.address() as { port: number }).port }
function record(transport: string, tags: string[] = []): object { return { id: 'protocol-device', workspaceId: 'ws', name: 'Protocol fixture', host: '127.0.0.1', port: transport === 'telnet' ? telnetPort : ['netconf', 'windows-ssh'].includes(transport) ? sshPort : httpsPort, username: transport.startsWith('winrm') ? 'FIXTURE\\fixture' : 'fixture', auth: 'password', os: 'Windows', rev: 1, route: [], tags: ['transport:' + transport, ...tags] } }
function cache(transport: string, tags: string[] = []): void { refreshMcpDataCache({ workspaces: [{ id: 'ws', name: 'Protocol lab' }], servers: [record(transport, tags)] }) }
async function client(mode: 'bypass' | 'readOnly' = 'bypass'): Promise<Client> {
  const session = createSession({ agentName: 'protocol-test', workspaces: [{ id: 'ws', name: 'Protocol lab' }], groupId: mode === 'bypass' ? 'grp-full-access' : 'grp-read-only', groupName: mode, mode, ttlMinutes: 60 })
  const c = new Client({ name: 'protocol-fixture', version: '1' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${session.token}` } } })); clients.push(c); return c
}
function body(r: unknown): string { return ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text ?? '').join('\n') }
function data(r: unknown): any { const s = body(r); return JSON.parse(s.slice(s.indexOf('{'))) }
async function call(name: string, args: object = {}, mode: 'bypass' | 'readOnly' = 'bypass'): Promise<Awaited<ReturnType<Client['callTool']>>> { return (await client(mode)).callTool({ name, arguments: { serverName: 'Protocol fixture', ...args } }) }
const CHALLENGE = Buffer.from('0102030405060708', 'hex')
function ntlmChallenge(): string {
  const target = Buffer.from('FIXTURE', 'utf16le'), av = Buffer.alloc(8 + target.length)
  av.writeUInt16LE(2, 0); av.writeUInt16LE(target.length, 2); target.copy(av, 4)
  const b = Buffer.alloc(48 + target.length + av.length)
  b.write('NTLMSSP\0'); b.writeUInt32LE(2, 8); b.writeUInt16LE(target.length, 12); b.writeUInt16LE(target.length, 14); b.writeUInt32LE(48, 16)
  b.writeUInt32LE(ntlmV1 ? 0x00800201 : 0x00880201, 20); CHALLENGE.copy(b, 24)
  b.writeUInt16LE(av.length, 40); b.writeUInt16LE(av.length, 42); b.writeUInt32LE(48 + target.length, 44); target.copy(b, 48); av.copy(b, 48 + target.length)
  return b.toString('base64')
}
function verifyType3(b64: string): boolean {
  const b = Buffer.from(b64, 'base64')
  const field = (at: number): Buffer => b.subarray(b.readUInt32LE(at + 4), b.readUInt32LE(at + 4) + b.readUInt16LE(at))
  const domain = field(28).toString('utf16le'), user = field(36).toString('utf16le'), response = field(20)
  if (user !== 'fixture' || domain !== 'FIXTURE' || response.length < 48) return false
  const hash = createHmac('md5', md4.createNTLMHash(PASSWORD)).update(Buffer.from(user.toUpperCase() + domain, 'utf16le')).digest()
  const proof = createHmac('md5', hash).update(Buffer.concat([CHALLENGE, response.subarray(16)])).digest()
  return timingSafeEqual(proof, response.subarray(0, 16))
}
beforeAll(async () => {
  originalRoots = caApi.getCACertificates('default'); caApi.setDefaultCACertificates([...originalRoots, cert])
  telnet = createTcpServer((socket) => {
    keep(socket); connections++; const codec = new TelnetCodec(); let buffer = '', phase = 0
    socket.write(Buffer.from([255])); socket.write(Buffer.from([251, 1])); socket.write('Username: ')
    socket.on('data', (b) => {
      buffer += codec.decode(b).data.toString('utf8')
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0 || (phase >= 2 && (end = buffer.indexOf('\r')) >= 0)) {
        const line = buffer.slice(0, end).replace(/\r/g, ''); buffer = buffer.slice(end + 1); if (!line && phase >= 2) continue
        telnetLines.push(line)
        if (phase === 0) { phase++; socket.write('Password: ') }
        else if (phase === 1) { phase++; if (badPassword || line !== PASSWORD) socket.end('Login incorrect\r\nUsername: '); else socket.write('\r\n<Fixture>') }
        else { commands.push(line); if (line.startsWith('description ')) telnetDescription = line.slice(12); socket.write(line + '\r\n' + (line === 'display version' ? 'Huawei Telnet fixture\r\n' : line === 'display current-configuration' ? `interface GE1/0/1\r\n description ${telnetDescription}\r\n#\r\n` : '') + '<Fixture>') }
      }
    })
  }); telnetPort = await listening(telnet)
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey
  ssh = new SshServer({ hostKeys: [hostKey] }, (connection) => {
    connections++; sshClients.push(connection); connection.on('error', () => {}); connection.on('authentication', (auth) => auth.accept())
    connection.on('ready', () => {
      connection.on('tcpip', (accept, _reject, info) => { const upstream = tcpConnect(info.destPort, info.destIP); const channel = accept(); upstream.pipe(channel).pipe(upstream); keep(upstream) })
      connection.on('session', (accept) => {
        const session = accept()
        session.on('subsystem', (acceptSubsystem, _reject, info) => {
          expect(info.name).toBe('netconf'); const stream = acceptSubsystem(); const f = new NetconfFramer(); let hello = false
          stream.on('data', (b: Buffer) => {
            f.push(b); let frame: string | undefined
            while ((frame = f.next()) !== undefined) {
              const root = parseXml(frame)
              if (!hello) {
                hello = true; stream.write(netconfFrame(`<hello xmlns="${NETCONF_NS}"><capabilities><capability>urn:ietf:params:netconf:base:1.${base11 ? '1' : '0'}</capability></capabilities><session-id>42</session-id></hello>`, false)); f.chunked = base11
              } else {
                rpcRequests.push(frame)
                const operation = root.children[0]
                const reply = rpcError && operation.name !== 'get-config' ? '<rpc-error><error-type>application</error-type><error-tag>operation-failed</error-tag><error-severity>error</error-severity></rpc-error>' : operation.name === 'get' ? '<data><state>fixture</state></data>' : operation.name === 'get-config' ? '<data><configuration>synthetic baseline</configuration></data>' : '<ok/>'
                stream.write(netconfFrame(`<rpc-reply xmlns="${NETCONF_NS}" message-id="${badId ? 'wrong' : root.attrs['message-id']}">${reply}</rpc-reply>`, base11))
              }
            }
          })
        })
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec(); const script = Buffer.from(info.command.split(' ').at(-1)!, 'base64').toString('utf16le'); scripts.push(script)
          stream.write('Windows SSH fixture'); if (exitCode) stream.stderr.write('Synthetic failure'); stream.exit(exitCode); stream.end()
        })
      })
    })
  }); sshPort = await listening(ssh)
  const parsed = utils.parseKey(hostKey); if (parsed instanceof Error) throw parsed
  writeFileSync(join(app.getPath('userData'), 'opsmaxx-known-hosts.json'), JSON.stringify({ [`127.0.0.1:${sshPort}`]: { id: `127.0.0.1:${sshPort}`, fingerprint: fingerprint(parsed.getPublicSSH()), addedAt: new Date().toISOString() } }))
  const authenticated = new WeakSet<Socket>()
  https = createHttpsServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = []; req.on('data', (b) => chunks.push(b)); req.on('end', () => {
      const content = Buffer.concat(chunks).toString('utf8')
      if (req.url === '/command-api') {
        jsonCount++
        if (req.headers.authorization !== 'Basic ' + Buffer.from('fixture:' + PASSWORD).toString('base64')) { res.writeHead(401); res.end(); return }
        const r = JSON.parse(content); commands.push(JSON.stringify(r.params)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: badId ? 'wrong' : r.id, ...(rpcError ? { error: { code: -1, message: 'synthetic failure' } } : { result: { version: 'EOS fixture' } }) })); return
      }
      const authorization = req.headers.authorization ?? ''
      if (authorization.startsWith('NTLM ')) {
        const b64 = authorization.slice(5), message = Buffer.from(b64, 'base64')
        if (message.readUInt32LE(8) === 1) { res.writeHead(401, { 'WWW-Authenticate': 'NTLM ' + ntlmChallenge() }); res.end(); return }
        type3Count++; if (!verifyType3(b64)) { res.writeHead(401); res.end(); return }; authenticated.add(req.socket)
      } else if (!authenticated.has(req.socket) && authorization !== 'Basic ' + Buffer.from('FIXTURE\\fixture:' + PASSWORD).toString('base64')) { res.writeHead(401); res.end(); return }
      const root = parseXml(content), id = descendants(root, 'MessageID')[0].text, action = descendants(root, 'Action')[0].text
      soapActions.push(action)
      let result = ''
      if (action.endsWith('/Create')) result = '<w:SelectorSet><w:Selector Name="ShellId">fixture-shell</w:Selector></w:SelectorSet>'
      else if (action.endsWith('/Command')) { const args = descendants(root, 'Arguments')[0].text; scripts.push(Buffer.from(args.split(' ').at(-1)!, 'base64').toString('utf16le')); result = '<rsp:CommandId>fixture-command</rsp:CommandId>' }
      else if (action.endsWith('/Receive')) {
        if (receiveTimeout) { receiveTimeout = false; result = '<s:Fault><s:Code><s:Value>s:Receiver</s:Value></s:Code><s:Detail><f:WSManFault xmlns:f="http://schemas.microsoft.com/wbem/wsman/1/wsmanfault" Code="2150858793"/></s:Detail></s:Fault>'; res.statusCode = 500 }
        else result = `<rsp:ReceiveResponse><rsp:Stream Name="stdout" CommandId="fixture-command">${Buffer.from('Windows WinRM fixture 中文').toString('base64')}</rsp:Stream><rsp:CommandState CommandId="fixture-command" State="http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done"><rsp:ExitCode>${exitCode}</rsp:ExitCode></rsp:CommandState></rsp:ReceiveResponse>`
      } else if (action.endsWith('/Delete') && deleteFailure) { res.statusCode = 500; result = '<s:Fault/>' }
      else result = '<rsp:Completed/>'
      res.setHeader('Content-Type', 'application/soap+xml'); res.end(`<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:w="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd" xmlns:rsp="http://schemas.microsoft.com/wbem/wsman/1/windows/shell"><s:Header><a:RelatesTo>${xmlEscape(badId ? 'wrong' : id)}</a:RelatesTo></s:Header><s:Body>${result}</s:Body></s:Envelope>`)
    })
  }); https.on('connection', (socket) => { connections++; keep(socket); if (revokeOnHttpsConnect) cache('netconf') }); httpsPort = await listening(https)
  resetMcpAuthForTests(); resetPolicyCacheForTests(); cache('telnet', ['network:huawei_vrp']); setSecret('protocol-device', JSON.stringify({ password: PASSWORD }))
  setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full-access'); setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
  unsubscribe = onApprovalEvent((event) => { if (event.type === 'created') { approvals.push(JSON.stringify(event.request)); approvalEdit?.(); setImmediate(() => respondToApproval(event.request.id, answer)) } })
  expect((await startMcpServer()).ok).toBe(true)
}, 30000)
beforeEach(() => { poolDisposeAll(); cache('telnet', ['network:huawei_vrp']); commands.length = telnetLines.length = rpcRequests.length = soapActions.length = scripts.length = 0; approvals = []; answer = 'approved'; approvalEdit = undefined; rpcError = badId = receiveTimeout = badPassword = ntlmV1 = deleteFailure = revokeOnHttpsConnect = false; exitCode = jsonCount = connections = type3Count = 0; base11 = true; telnetDescription = 'Fixture'; resetApprovalVolumeForTests() })
afterEach(async () => { await Promise.all(clients.splice(0).map((c) => c.close())); poolDisposeAll() })
afterAll(async () => { unsubscribe(); await stopMcpServer(); poolDisposeAll(); for (const c of sshClients) c.end(); for (const s of sockets) s.destroy(); await Promise.all([telnet, https, ssh].map((s) => new Promise<void>((resolve) => s.close(() => resolve())))); caApi.setDefaultCACertificates(originalRoots) })

describe('remote protocol fixtures through authenticated MCP', () => {
  it('logs in once over real Telnet, negotiates split IAC and reuses network queries', async () => {
    const r = await call('network_get_state', { query: 'version' }); expect(r.isError).not.toBe(true); expect(data(r).output).toBe('Huawei Telnet fixture'); expect(telnetLines.slice(0, 2)).toEqual(['fixture', PASSWORD]); expect(commands).toEqual(['screen-length 0 temporary', 'display version'])
  })
  it('does not retry failed Telnet credentials or return them', async () => { badPassword = true; const r = await call('network_get_state', { query: 'version' }); expect(r.isError).toBe(true); expect(body(r)).not.toContain(PASSWORD); expect(connections).toBe(1); expect(commands).toHaveLength(0) })
  it('applies a Telnet configuration only through an approved immutable plan and verifies readback', async () => {
    cache('telnet', ['network:huawei_vrp', 'network:configure'])
    const c = await client()
    const plan = data(await c.callTool({ name: 'network_plan_change', arguments: { serverName: 'Protocol fixture', changes: [{ kind: 'interface_description', target: 'GE1/0/1', value: 'Telnet acceptance' }], persist: false } }))
    expect(commands).not.toContain('system-view')
    const result = await c.callTool({ name: 'network_apply_change', arguments: { serverName: 'Protocol fixture', planId: plan.planId, planHash: plan.planHash } })
    expect(result.isError).not.toBe(true); expect(data(result).status).toBe('applied_and_readback_verified'); expect(telnetDescription).toBe('Telnet acceptance'); expect(approvals).toHaveLength(1)
  })
  it('carries HTTPS through a saved SSH bastion while validating the original TLS hostname', async () => {
    const cfg = { host: '127.0.0.1', port: httpsPort, auth: 'password' as const, username: 'fixture', password: PASSWORD, hops: [{ host: '127.0.0.1', port: sshPort, auth: 'password' as const, username: 'fixture', password: PASSWORD }] }
    const result = await boundedProtocol((ctx) => callJsonRpc(cfg, 'runCmds', {}, ctx), () => {})
    expect(result).toEqual({ version: 'EOS fixture' }); expect(jsonCount).toBe(1)
  })
  it.each([false, true])('reads NETCONF over a real SSH subsystem with base 1.%s framing', async (chunked) => { base11 = chunked; cache('netconf'); const r = await call('netconf_read', { kind: 'state', filter: '<state xmlns="urn:fixture"/>' }); expect(r.isError).not.toBe(true); expect(data(r).output).toContain('fixture'); expect(rpcRequests).toHaveLength(1) })
  it('stores NETCONF configs as encrypted artifacts and returns no baseline text', async () => { cache('netconf'); const r = await call('netconf_read', { kind: 'config' }); expect(data(r).backup.encrypted).toBe(true); expect(body(r)).not.toContain('synthetic baseline') })
  it('backs up before an approved RPC, checks exact-content approval, and returns rpc-error as failure without retry', async () => {
    cache('netconf', ['rpc:write']); rpcError = true
    const r = await call('netconf_rpc', { operationXml: `<commit xmlns="${NETCONF_NS}"/>` }); expect(r.isError).toBe(true); expect(rpcRequests).toHaveLength(2); expect(rpcRequests[0]).toContain('get-config'); expect(body(r)).toContain('Protected recovery backup'); expect(approvals).toHaveLength(1); expect(approvals[0]).toContain('commit')
  })
  it('refuses wrong NETCONF IDs', async () => { cache('netconf'); badId = true; expect((await call('netconf_read', { kind: 'state' })).isError).toBe(true); expect(rpcRequests).toHaveLength(1) })
  it('refuses custom RPCs without human opt-in or read-only policy before any connection', async () => {
    cache('netconf'); expect((await call('netconf_rpc', { operationXml: '<commit/>' })).isError).toBe(true)
    cache('netconf', ['rpc:write']); expect((await call('netconf_rpc', { operationXml: '<commit/>' }, 'readOnly')).isError).toBe(true); expect(connections).toBe(0)
  })
  it('stops an approved request if the saved identity changes while approval is pending', async () => {
    cache('netconf', ['rpc:write']); approvalEdit = () => cache('jsonrpc', ['rpc:write']); const r = await call('netconf_rpc', { operationXml: '<commit/>' }); expect(r.isError).toBe(true); expect(connections).toBe(0)
  })
  it('reads Arista eAPI over TLS with a real saved password and validates response IDs/errors', async () => {
    cache('jsonrpc', ['network:arista_eos']); const ok = await call('jsonrpc_get_state', { query: 'version' }); expect(data(ok).version).toBe('EOS fixture'); expect(commands[0]).toContain('show version'); expect(approvals).toHaveLength(0)
    badId = true; expect((await call('jsonrpc_get_state', { query: 'version' })).isError).toBe(true); expect(jsonCount).toBe(2)
  })
  it('requires a fresh approval for every JSON-RPC call, and never retries RPC errors', async () => {
    cache('jsonrpc', ['rpc:write']); rpcError = true
    const args = { method: 'runCmds', params: { version: 1, cmds: ['configure', 'vlan 123'], format: 'json' } }
    expect((await call('jsonrpc_call', args)).isError).toBe(true); expect(jsonCount).toBe(1); expect(approvals[0]).toContain('vlan 123')
    rpcError = false; expect((await call('jsonrpc_call', args)).isError).not.toBe(true); expect(approvals).toHaveLength(2); expect(jsonCount).toBe(2)
  })
  it('rechecks identity after dialing and before handing HTTPS a TLS socket to send the approved body', async () => {
    cache('jsonrpc', ['rpc:write']); revokeOnHttpsConnect = true
    const r = await call('jsonrpc_call', { method: 'runCmds', params: { cmds: ['configure', 'vlan 123'] } })
    expect(r.isError).toBe(true); expect(jsonCount).toBe(0); expect(approvals).toHaveLength(1)
  })
  it('refuses denied PowerShell before login, and never leaks a saved password', async () => {
    cache('winrm-ntlm', ['remote:execute']); answer = 'denied'; const r = await call('windows_run_script', { script: 'Write-Output "review me"' }); expect(r.isError).toBe(true); expect(connections).toBe(0); expect(approvals[0]).toContain('review me'); expect(body(r)).not.toContain(PASSWORD)
  })
  it.each(['winrm-ntlm', 'winrm-basic'])('runs remote PowerShell through real %s SOAP and cleans up the shell', async (transport) => {
    cache(transport, ['remote:execute']); receiveTimeout = true
    const r = await call('windows_run_script', { script: 'Write-Output "中文"' }); expect(r.isError).not.toBe(true); expect(data(r)).toMatchObject({ stdout: 'Windows WinRM fixture 中文', exitCode: 0, cleanup: 'completed' }); expect(scripts[0]).toContain('Write-Output "中文"'); expect(soapActions.filter((a) => a.endsWith('/Command'))).toHaveLength(1); expect(soapActions.at(-1)).toContain('/Delete'); expect(approvals).toHaveLength(1); if (transport === 'winrm-ntlm') expect(type3Count).toBe(1)
  })
  it('refuses NTLMv1 without sending a Type3 password response or creating a shell', async () => { cache('winrm-ntlm'); ntlmV1 = true; const r = await call('windows_get_facts'); expect(r.isError).toBe(true); expect(type3Count).toBe(0); expect(soapActions).toHaveLength(0) })
  it('reports Windows nonzero exit codes and unconfirmed shell cleanup as errors', async () => {
    cache('winrm-basic', ['remote:execute']); exitCode = 7; const failed = await call('windows_run_script', { script: 'exit 7' }); expect(failed.isError).toBe(true); expect(data(failed).exitCode).toBe(7)
    exitCode = 0; deleteFailure = true; const cleanup = await call('windows_get_facts'); expect(cleanup.isError).toBe(true); expect(data(cleanup).cleanup).toBe('failed')
  })
  it('runs only encoded remote PowerShell on Windows SSH and captures stderr and exit status', async () => {
    cache('windows-ssh', ['remote:execute']); exitCode = 7; const r = await call('windows_run_script', { script: 'Write-Error "fixture"; exit 7' }); expect(r.isError).toBe(true); expect(data(r)).toMatchObject({ exitCode: 7, stderr: 'Synthetic failure', transport: 'windows-ssh' }); expect(scripts[0]).toContain('Write-Error "fixture"')
  })
  it('keeps fixed Windows facts available without arbitrary execution opt-in', async () => { cache('winrm-basic'); expect((await call('windows_run_script', { script: 'whoami' })).isError).toBe(true); expect(connections).toBe(0); const r = await call('windows_get_facts'); expect(r.isError).not.toBe(true); expect(scripts[0]).toContain('Get-CimInstance Win32_OperatingSystem') })
  it('refuses ordinary SSH tools on a non-SSH protocol record', async () => { cache('telnet'); const r = await call('execute_command', { command: 'whoami' }); expect(r.isError).toBe(true); expect(connections).toBe(0) })
  it('rejects untrusted TLS instead of bypassing certificate validation', async () => {
    caApi.setDefaultCACertificates(originalRoots)
    try { await expect(boundedProtocol((ctx) => callJsonRpc({ host: '127.0.0.1', port: httpsPort, username: 'fixture', password: PASSWORD, auth: 'password' }, 'runCmds', {}, ctx), () => {})).rejects.toThrow(); expect(jsonCount).toBe(0) }
    finally { caApi.setDefaultCACertificates([...originalRoots, cert]) }
  })
  it('refuses raw VPN/cloud routes without silently dialing directly', async () => { await expect(boundedProtocol((ctx) => openProtocolSocket({ host: '127.0.0.1', port: httpsPort, auth: 'password', username: 'fixture', vpnProfileId: 'fixture-vpn' }, ctx), () => {})).rejects.toThrow('fallback'); expect(connections).toBe(0) })
})
