import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { acquire, release } from './ssh'
import { powerShellCommand } from '../../shared/remoteProtocol'
import { abortable, ProtocolHttps, PROTOCOL_LIMITS, parseXml, descendants, xmlEscape, type XmlNode, type ProtocolTarget, type ProtocolContext } from './protocolWire'

// Only the low-level message API is loaded; the package's optional HTTP helper falls back to Basic and is NEVER used.
const ntlm = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)('@ewsjs/ntlm-client') as {
  createType1Message: (workstation?: string, domain?: string) => string
  decodeType2Message: (header: string) => { version: number; targetInfo?: unknown }
  createType3Message: (type2: unknown, username: string, password: string, workstation?: string, domain?: string) => string
}
const SOAP = 'http://www.w3.org/2003/05/soap-envelope'
const ADDRESS = 'http://schemas.xmlsoap.org/ws/2004/08/addressing'
const WSMAN = 'http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd'
const SHELL = 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell'
const TRANSFER = 'http://schemas.xmlsoap.org/ws/2004/09/transfer/'
export interface WindowsResult { stdout: string; stderr: string; exitCode: number; cleanup: 'completed' | 'failed'; transport: string }
export function soapEnvelope(host: string, port: number, action: string, id: string, body: string, shellId?: string): string {
  return `<s:Envelope xmlns:s="${SOAP}" xmlns:a="${ADDRESS}" xmlns:w="${WSMAN}" xmlns:rsp="${SHELL}"><s:Header><a:To s:mustUnderstand="true">https://${xmlEscape(host)}:${port}/wsman</a:To><a:ReplyTo><a:Address s:mustUnderstand="true">${ADDRESS}/role/anonymous</a:Address></a:ReplyTo><a:MessageID>uuid:${id}</a:MessageID><w:MaxEnvelopeSize s:mustUnderstand="true">153600</w:MaxEnvelopeSize><w:OperationTimeout>PT10S</w:OperationTimeout><w:ResourceURI s:mustUnderstand="true">${SHELL}/cmd</w:ResourceURI><a:Action s:mustUnderstand="true">${action}</a:Action>${shellId ? `<w:SelectorSet><w:Selector Name="ShellId">${xmlEscape(shellId)}</w:Selector></w:SelectorSet>` : '<w:OptionSet><w:Option Name="WINRS_NOPROFILE">TRUE</w:Option><w:Option Name="WINRS_CODEPAGE">65001</w:Option></w:OptionSet>'}</s:Header><s:Body>${body}</s:Body></s:Envelope>`
}
export function parseSoap(body: string, id: string): XmlNode {
  const node = parseXml(body)
  const relates = descendants(node, 'RelatesTo', ADDRESS)
  if (node.name !== 'Envelope' || node.ns !== SOAP || relates.length !== 1 || relates[0].text.trim() !== `uuid:${id}`) throw new Error('WinRM response identity mismatch')
  return node
}
export async function windowsSsh(cfg: ProtocolTarget, script: string, ctx: ProtocolContext): Promise<WindowsResult> {
  const command = powerShellCommand(script)
  ctx.check()
  const conn = await abortable(acquire(cfg), ctx.signal, release)
  try {
    ctx.check()
    return await new Promise<WindowsResult>((resolve, reject) => {
      let channel: import('ssh2').ClientChannel | undefined
      const cancel = (): void => { channel?.destroy(); reject(new Error('Windows SSH cancelled; remote process state may be unknown')) }
      ctx.signal.addEventListener('abort', cancel, { once: true })
      conn.client.exec(command, (error, stream) => {
        if (error) { ctx.signal.removeEventListener('abort', cancel); reject(new Error('Windows SSH exec refused')); return }
        channel = stream
        if (ctx.signal.aborted) { stream.destroy(); cancel(); return }
        const stdout: Buffer[] = [], stderr: Buffer[] = []
        let bytes = 0
        const receive = (sink: Buffer[]) => (b: Buffer): void => { bytes += b.length; if (bytes > PROTOCOL_LIMITS.outputBytes) { stream.destroy(); reject(new Error('Windows output limit exceeded; result incomplete')) } else sink.push(Buffer.from(b)) }
        stream.on('data', receive(stdout)); stream.stderr.on('data', receive(stderr))
        stream.on('error', () => reject(new Error('Windows SSH stream failed; state unknown')))
        stream.once('close', (code: number | undefined) => { ctx.signal.removeEventListener('abort', cancel); if (!Number.isInteger(code)) reject(new Error('Windows SSH did not return an exit code')); else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code as number, cleanup: 'completed', transport: 'windows-ssh' }) })
      })
    })
  } finally { release(conn) }
}
export class WinrmClient {
  private http: ProtocolHttps
  private authenticated = false
  private authSocket: unknown
  constructor(private cfg: ProtocolTarget, private mode: 'ntlm' | 'basic', private ctx: ProtocolContext) { this.http = new ProtocolHttps(cfg, ctx) }
  private async send(action: string, body: string, shellId?: string): Promise<XmlNode> {
    const id = randomUUID()
    const envelope = soapEnvelope(this.cfg.host, this.cfg.port, action, id, body, shellId)
    const headers = { 'Content-Type': 'application/soap+xml;charset=UTF-8' }
    const post = (authorization?: string, empty = false, socket?: unknown): ReturnType<ProtocolHttps['post']> => this.http.post('/wsman', empty ? '' : envelope, { ...headers, ...(authorization ? { Authorization: authorization } : {}) }, socket)
    let response: Awaited<ReturnType<ProtocolHttps['post']>>
    if (this.mode === 'basic') response = await post('Basic ' + Buffer.from(this.cfg.username + ':' + this.cfg.password).toString('base64'))
    else if (!this.authenticated) {
      // Empty body handshake cannot create a shell or execute a command on a misconfigured endpoint.
      const challenge = await post(ntlm.createType1Message('OPSMAXX', ''), true)
      const header = challenge.headers['www-authenticate']
      const match = typeof header === 'string' ? header.match(/(?:^|,\s*)NTLM\s+([A-Za-z0-9+/=]+)/i) : null
      if (challenge.status !== 401 || !match || match[1].length > 16384 || challenge.headers.connection?.toLowerCase() === 'close') throw new Error('WinRM NTLM challenge refused')
      const type2 = ntlm.decodeType2Message(match[1])
      if (type2.version !== 2 || !type2.targetInfo) throw new Error('WinRM NTLMv1 downgrade refused')
      const split = this.cfg.username.indexOf('\\')
      const domain = split >= 0 ? this.cfg.username.slice(0, split) : undefined
      const username = split >= 0 ? this.cfg.username.slice(split + 1) : this.cfg.username
      response = await post(ntlm.createType3Message(type2, username, this.cfg.password as string, 'OPSMAXX', domain), false, challenge.socket)
      if (response.socket !== challenge.socket) throw new Error('WinRM authentication changed connection; no retry')
      this.authenticated = response.status >= 200 && response.status < 300
      this.authSocket = response.socket
    } else {
      response = await post(undefined, false, this.authSocket)
      if (response.socket !== this.authSocket) throw new Error('WinRM authenticated connection was lost; no retry')
    }
    const node = parseSoap(response.body, id)
    if (descendants(node, 'Fault', SOAP).length) {
      const faults = descendants(node, 'WSManFault', 'http://schemas.microsoft.com/wbem/wsman/1/wsmanfault')
      if (action === SHELL + '/Receive' && faults.some((f) => f.attrs.Code === '2150858793')) throw new WinrmReceiveTimeout()
      throw new Error('WinRM SOAP fault returned; no command retry')
    }
    if (response.status < 200 || response.status >= 300) throw new Error('WinRM HTTP request refused; no retry')
    return node
  }
  async run(script: string): Promise<WindowsResult> {
    if (this.cfg.auth !== 'password' || !this.cfg.password || !this.cfg.username || this.cfg.username.length + this.cfg.password.length > 400) throw new Error('WinRM requires a trusted saved password within the supported NTLM length')
    const full = powerShellCommand(script)
    const space = full.indexOf(' ')
    let shellId: string | undefined
    let commandId: string | undefined
    let cleanup: WindowsResult['cleanup'] = 'failed'
    let output: Omit<WindowsResult, 'cleanup'> | undefined
    try {
      const shell = await this.send(TRANSFER + 'Create', '<rsp:Shell><rsp:InputStreams>stdin</rsp:InputStreams><rsp:OutputStreams>stdout stderr</rsp:OutputStreams><rsp:IdleTimeOut>PT60S</rsp:IdleTimeOut></rsp:Shell>')
      shellId = descendants(shell, 'Selector', WSMAN).find((n) => n.attrs.Name === 'ShellId')?.text
      if (!shellId || shellId.length > 200) throw new Error('WinRM ShellId missing')
      const command = await this.send(SHELL + '/Command', `<rsp:CommandLine><rsp:Command>${xmlEscape(full.slice(0, space))}</rsp:Command><rsp:Arguments>${xmlEscape(full.slice(space + 1))}</rsp:Arguments></rsp:CommandLine>`, shellId)
      commandId = descendants(command, 'CommandId', SHELL)[0]?.text
      if (!commandId || commandId.length > 200) throw new Error('WinRM CommandId missing; process state unknown')
      const stdout: Buffer[] = [], stderr: Buffer[] = []
      let total = 0
      for (let count = 0; count < 64; count++) {
        this.ctx.check()
        let received: XmlNode
        try { received = await this.send(SHELL + '/Receive', `<rsp:Receive><rsp:DesiredStream CommandId="${xmlEscape(commandId)}">stdout stderr</rsp:DesiredStream></rsp:Receive>`, shellId) }
        catch (e) { if (e instanceof WinrmReceiveTimeout) continue; throw e }
        for (const stream of descendants(received, 'Stream', SHELL)) {
          if (stream.attrs.CommandId && stream.attrs.CommandId !== commandId) throw new Error('WinRM output belongs to another command')
          const b64 = stream.text.replace(/\s/g, '')
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) throw new Error('Invalid WinRM base64 output')
          const bytes = Buffer.from(b64, 'base64'); total += bytes.length
          if (total > PROTOCOL_LIMITS.outputBytes) throw new Error('Windows output limit exceeded; result incomplete')
          if (stream.attrs.Name === 'stdout') stdout.push(bytes)
          else if (stream.attrs.Name === 'stderr') stderr.push(bytes)
          else throw new Error('Unexpected WinRM output stream')
        }
        const state = descendants(received, 'CommandState', SHELL)[0]
        if (state?.attrs.CommandId !== commandId) throw new Error('WinRM command state identity mismatch')
        if (state.attrs.State === SHELL + '/CommandState/Done') {
          const code = descendants(state, 'ExitCode', SHELL)[0]?.text
          if (!code || !/^-?\d+$/.test(code)) throw new Error('Windows exit code missing')
          output = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: Number(code), transport: 'winrm-' + this.mode }
          break
        }
      }
      if (!output) throw new Error('WinRM receive limit exceeded; process state unknown')
    } finally {
      // Cleanup is bounded by the same deadline and authorization; never reconnect after an uncertain result.
      if (shellId && !this.ctx.signal.aborted) {
        try {
          if (commandId) { try { await this.send(SHELL + '/Signal', `<rsp:Signal CommandId="${xmlEscape(commandId)}"><rsp:Code>${SHELL}/signal/terminate</rsp:Code></rsp:Signal>`, shellId) } catch { /* Delete is still necessary when a completed command refuses Signal. */ } }
          await this.send(TRANSFER + 'Delete', '', shellId); cleanup = 'completed'
        } catch { cleanup = 'failed' }
      }
      this.http.close()
    }
    return { ...output, cleanup }
  }
}
class WinrmReceiveTimeout extends Error {}
