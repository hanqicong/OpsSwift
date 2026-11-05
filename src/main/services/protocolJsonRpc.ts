import { randomUUID } from 'node:crypto'
import { ProtocolHttps, type ProtocolTarget, type ProtocolContext } from './protocolWire'

export function validateJsonRpc(method: string, params: unknown): void {
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(method) || method.startsWith('rpc.')) throw new Error('Invalid JSON-RPC method')
  if (!params || typeof params !== 'object' || Buffer.byteLength(JSON.stringify(params)) > 32 * 1024) throw new Error('JSON-RPC params must be an object or array within 32 KiB')
}
export function jsonRpcCommands(method: string, params: unknown): string[] {
  if (method !== 'runCmds') return []
  const cmds = (params as Record<string, unknown>).cmds
  if (!Array.isArray(cmds) || !cmds.length || cmds.length > 64) throw new Error('eAPI runCmds requires one to sixty-four commands')
  return cmds.map((value) => {
    const command = typeof value === 'string' ? value : value && typeof value === 'object' && 'cmd' in value ? value.cmd : undefined
    // eslint-disable-next-line no-control-regex
    if (typeof command !== 'string' || !command.trim() || /[\x00-\x1f\x7f]/.test(command)) throw new Error('eAPI command must be one literal line')
    return command
  })
}
export function jsonRpcResult(body: string, id: string): unknown {
  const result = JSON.parse(body)
  if (!result || Array.isArray(result) || result.jsonrpc !== '2.0' || result.id !== id || Object.hasOwn(result, 'error') === Object.hasOwn(result, 'result')) throw new Error('Invalid JSON-RPC response or identity mismatch')
  if (Object.hasOwn(result, 'error')) throw new Error('JSON-RPC error returned; no automatic retry')
  return result.result
}
/** Fixed Arista eAPI-compatible HTTPS endpoint. No notifications, batch, redirects or caller URL. */
export async function callJsonRpc(cfg: ProtocolTarget, method: string, params: unknown, ctx: ProtocolContext): Promise<unknown> {
  validateJsonRpc(method, params)
  if (cfg.auth !== 'password' || !cfg.password || !cfg.username || cfg.username.includes(':')) throw new Error('JSON-RPC requires a trusted saved Basic credential')
  const id = randomUUID()
  const http = new ProtocolHttps(cfg, ctx)
  try {
    const response = await http.post('/command-api', JSON.stringify({ jsonrpc: '2.0', id, method, params }), { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(cfg.username + ':' + cfg.password).toString('base64') })
    if (response.status !== 200) throw new Error('JSON-RPC HTTP failure; no automatic retry or redirect')
    return jsonRpcResult(response.body, id)
  } finally { http.close() }
}
