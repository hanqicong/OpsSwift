/** Native Electron smoke test. Runs only in an explicitly isolated synthetic profile. */
import { app, safeStorage } from 'electron'
import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { NETWORK_PROFILES } from '../src/shared/networkDevice'
import { refreshMcpDataCache } from '../src/main/services/mcpDataCache'
import { setMcpConfig, createSession, resetMcpAuthForTests } from '../src/main/services/mcpAuth'
import { startMcpServer, stopMcpServer } from '../src/main/services/mcpServer'
import { storeNetworkBackup } from '../src/main/services/networkCli'

app.setName('OpsSwift')
app.whenReady().then(async () => {
  const expected = process.env.OPSMAXX_NETWORK_SMOKE_DIR
  const report = process.env.OPSMAXX_NETWORK_SMOKE_REPORT
  if (!expected || !report || resolve(app.getPath('userData')) !== resolve(expected) || !expected.includes('opsswift/.runtime/')) throw new Error('Refusing a non-isolated smoke profile')
  resetMcpAuthForTests()
  refreshMcpDataCache({ workspaces: [{ id: 'synthetic', name: 'Synthetic smoke fixture' }], servers: [] })
  setMcpConfig({ enabled: true, port: 18994, approvalTimeoutSeconds: 5 })
  const session = createSession({ agentName: 'synthetic-native-smoke', workspaces: [{ id: 'synthetic', name: 'Synthetic smoke fixture' }], mode: 'readOnly', groupId: 'grp-read-only', groupName: 'Read only', ttlMinutes: 5 })
  if (!(await startMcpServer()).ok) throw new Error('Native MCP start failed')
  const client = new Client({ name: 'synthetic-smoke', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18994/mcp'), { requestInit: { headers: { Authorization: `Bearer ${session.token}` } } }))
  const tools = (await client.listTools()).tools.filter((t) => /^(network_|protocol_|netconf_|jsonrpc_|windows_)/.test(t.name)).map((t) => t.name)
  if (tools.length !== 14) throw new Error('Native MCP network tool discovery failed')
  const profiles = await client.callTool({ name: 'network_list_profiles', arguments: {} })
  if (profiles.isError) throw new Error('Native MCP profile listing failed')
  const encryptionAvailable = safeStorage.isEncryptionAvailable()
  let backupVerified = false
  if (encryptionAvailable) backupVerified = storeNetworkBackup('interface GE1/0/1\n description synthetic-native-fixture\n#').encrypted
  writeFileSync(report, JSON.stringify({ electron: process.versions.electron, node: process.versions.node, isolatedProfile: true, extensionTools: tools, profileCount: NETWORK_PROFILES.length, encryptionAvailable, osEncryptedBackupReadbackVerified: backupVerified, realDeviceAccessed: false }, null, 2) + '\n')
  await client.close(); await stopMcpServer(); app.exit(0)
}).catch(() => { console.error('Native network smoke test failed; no credential or device configuration is printed.'); app.exit(1) })
