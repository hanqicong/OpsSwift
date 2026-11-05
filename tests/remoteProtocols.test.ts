import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { remoteTransport, powerShellCommand } from '../src/shared/remoteProtocol'
import { parseXml, boundedProtocol, abortable } from '../src/main/services/protocolWire'
import { TelnetCodec } from '../src/main/services/protocolTelnet'
import { NetconfFramer, netconfFrame, NetconfSession, NETCONF_NS, validateRpcOperation, netconfReadOperation } from '../src/main/services/protocolNetconf'
import { jsonRpcResult, validateJsonRpc } from '../src/main/services/protocolJsonRpc'
import { parseSoap } from '../src/main/services/protocolWindows'

describe('remote protocol boundaries', () => {
  it('requires a single supported saved transport and defaults old connections to SSH', () => {
    expect(remoteTransport()).toBe('ssh')
    expect(remoteTransport(['transport:telnet'])).toBe('telnet')
    expect(() => remoteTransport(['transport:netconf', 'transport:telnet'])).toThrow()
    expect(() => remoteTransport(['transport:evil'])).toThrow()
  })
  it.each(['<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>', '<a>&undefined;</a>', '<a/><b/>', '<a>'])('rejects unsafe or malformed XML: %s', (s) => expect(() => parseXml(s)).toThrow())
  it('limits XML nesting and preserves namespace identity', () => {
    expect(parseXml('<x:a xmlns:x="urn:test"><x:b>&lt;</x:b></x:a>').children[0]).toMatchObject({ name: 'b', ns: 'urn:test', text: '<' })
    expect(() => parseXml('<a>'.repeat(70) + '</a>'.repeat(70))).toThrow()
  })
  it('refuses nested envelopes, multi-root operations, DTD and delimiter injection', () => {
    for (const s of ['<rpc/>', '<hello/>', '<get/><reboot/>', '<get>]]>]]></get>', '<!DOCTYPE a><a/>']) expect(() => validateRpcOperation(s)).toThrow()
    expect(() => validateRpcOperation('<commit xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"/>')).not.toThrow()
    expect(netconfReadOperation('state', '<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces"/>')).toContain('type="subtree"')
  })
  it('handles split Telnet negotiation, IAC escapes and avoids response loops', () => {
    const codec = new TelnetCodec()
    expect(codec.decode(Buffer.from([255])).data.length).toBe(0)
    expect(codec.decode(Buffer.from([251, 1, 65, 255, 255])).replies).toEqual([Buffer.from([255, 253, 1])])
    expect(codec.decode(Buffer.from([255, 251, 1])).replies.length).toBe(0)
    expect(codec.decode(Buffer.from([255, 253, 42])).replies).toEqual([Buffer.from([255, 252, 42])])
    expect(codec.encode(Buffer.from([65, 255]))).toEqual(Buffer.from([65, 255, 255]))
    expect(codec.decode(Buffer.from([255, 250, 24, 1, 2, 255, 240, 66])).data.toString()).toBe('B')
    expect(() => codec.decode(Buffer.from([255, 250, ...Array(9000).fill(1)]))).toThrow()
  })
  it('negotiates interactive Telnet terminal type and resizes with escaped NAWS bytes', () => {
    const codec = new TelnetCodec({ cols: 120, rows: 40 })
    expect(codec.decode(Buffer.from([255, 253, 31])).replies).toEqual([Buffer.from([255, 251, 31]), Buffer.from([255, 250, 31, 0, 120, 0, 40, 255, 240])])
    expect(codec.resize(255, 24)).toEqual([Buffer.from([255, 250, 31, 0, 255, 255, 0, 24, 255, 240])])
    expect(codec.decode(Buffer.from([255, 253, 24])).replies).toEqual([Buffer.from([255, 251, 24])])
    codec.decode(Buffer.from([255, 250, 24]))
    expect(codec.decode(Buffer.from([1, 255, 240])).replies).toEqual([Buffer.from([255, 250, 24, 0, ...Buffer.from('VT100'), 255, 240])])
    codec.decode(Buffer.from([255, 254, 31])); expect(codec.resize(80, 24)).toEqual([])
  })
  it.each([false, true])('parses split UTF-8 NETCONF frames (chunked=%s)', (chunked) => {
    const f = new NetconfFramer(); f.chunked = chunked
    const input = '<data>华为</data>'
    const wire = netconfFrame(input, chunked)
    const messages: string[] = []
    for (const byte of wire) { f.push(Buffer.from([byte])); const m = f.next(); if (m) messages.push(m) }
    expect(messages).toEqual([input])
  })
  it.each(['\n#0\n', '\n#-1\n', '\n#9999999999\n', '\n##\n'])('refuses invalid NETCONF chunk header %j', (header) => {
    const f = new NetconfFramer(); f.chunked = true; f.push(Buffer.from(header)); expect(() => f.next()).toThrow()
  })
  it('refuses out-of-order NETCONF replies instead of treating an RPC as successful', async () => {
    const stream = new PassThrough()
    // Replace the outgoing write, while retaining an actual readable stream for incoming data.
    stream.write = (() => true) as typeof stream.write
    const controller = new AbortController()
    const session = new NetconfSession(stream, { signal: controller.signal, check: () => {} })
    const hello = session.hello()
    stream.emit('data', netconfFrame(`<hello xmlns="${NETCONF_NS}"><capabilities><capability>urn:ietf:params:netconf:base:1.0</capability></capabilities><session-id>1</session-id></hello>`, false)); await hello
    const call = session.rpc('<get/>')
    stream.emit('data', netconfFrame(`<rpc-reply xmlns="${NETCONF_NS}" message-id="wrong"><ok/></rpc-reply>`, false))
    await expect(call).rejects.toThrow('identity'); session.close()
  })
  it('requires a matching JSON-RPC 2.0 ID and exactly one result/error', () => {
    expect(jsonRpcResult('{"jsonrpc":"2.0","id":"1","result":null}', '1')).toBeNull()
    for (const body of ['[]', '{"jsonrpc":"2.0","id":"2","result":{}}', '{"jsonrpc":"2.0","id":"1","result":{},"error":{}}', '{"jsonrpc":"2.0","id":"1","error":{"code":-1}}']) expect(() => jsonRpcResult(body, '1')).toThrow()
    expect(() => validateJsonRpc('rpc.test', {})).toThrow(); expect(() => validateJsonRpc('runCmds', 'text')).toThrow()
  })
  it('encodes the reviewed script only for remote PowerShell and checks SOAP response identity', () => {
    const source = 'Write-Output "中文"; exit 7'
    const cmd = powerShellCommand(source)
    expect(Buffer.from(cmd.split(' ').at(-1)!, 'base64').toString('utf16le')).toContain(source)
    expect(cmd).not.toContain(source)
    expect(() => powerShellCommand('\0')).toThrow()
    expect(() => parseSoap('<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"/>', 'id')).toThrow('identity')
  })
  it('cancels a stalled operation and disposes a late connection', async () => {
    const controller = new AbortController(); let disposed = false
    const pending = abortable(new Promise<string>((resolve) => setTimeout(() => resolve('late'), 10)), controller.signal, () => { disposed = true })
    controller.abort(); await expect(pending).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 20)); expect(disposed).toBe(true)
    await expect(boundedProtocol(async () => 'unreachable', () => { throw new Error('revoked') })).rejects.toThrow('revoked')
  })
  it('ships a CSPRNG-only NTLM nonce patch and no Basic fallback helper', () => {
    const patch = readFileSync(resolve('patches/@ewsjs+ntlm-client+3.0.1.patch'), 'utf8')
    expect(patch).toContain('+\treturn crypto.randomBytes')
    const implementation = readFileSync(resolve('src/main/services/protocolWindows.ts'), 'utf8')
    expect(implementation).not.toContain("require('@ewsjs/ntlm-client/lib/ntlmrequest')")
    expect(implementation).toContain('type2.version !== 2')
  })
})
