import { describe, expect, it } from 'vitest'
import { terminalDecoder, encodeTerminal } from '../src/main/services/terminalCodec'
import { terminalEncodingFromTags, TERMINAL_ENCODINGS } from '../src/shared/terminalEncoding'
import { compileNetworkChanges, getNetworkProfile } from '../src/shared/networkDevice'
describe('CLI byte encoding', () => {
  it.each(TERMINAL_ENCODINGS)('preserves Chinese at every byte split in %s', encoding => {
    const text = '領益機房：華為終端\r\nHRP_M<防火牆>', bytes = encodeTerminal(text, encoding)
    for (let split = 0; split <= bytes.length; split++) {
      const decoder = terminalDecoder(encoding)
      expect(decoder.write(bytes.subarray(0, split)) + decoder.write(bytes.subarray(split)) + decoder.end()).toBe(text)
    }
    const decoder = terminalDecoder(encoding)
    expect([...bytes].map(byte => decoder.write(Buffer.from([byte]))).join('') + decoder.end()).toBe(text)
  })
  it('supports supplementary characters in UTF-8 and GB18030 and refuses lossy GBK/Big5 input', () => {
    for (const encoding of ['utf8', 'gb18030'] as const) {
      const decoder = terminalDecoder(encoding)
      expect(decoder.write(encodeTerminal('𠀀😀', encoding)) + decoder.end()).toBe('𠀀😀')
    }
    for (const encoding of ['gbk', 'big5'] as const) expect(() => encodeTerminal('😀', encoding)).toThrow('cannot be represented')
    expect(() => encodeTerminal('\ud800', 'utf8')).toThrow('cannot be represented')
  })
  it('defaults to UTF-8, honors one saved selection and refuses ambiguity', () => {
    expect(terminalEncodingFromTags()).toBe('utf8')
    expect(terminalEncodingFromTags(['encoding:gbk'])).toBe('gbk')
    expect(() => terminalEncodingFromTags(['encoding:gbk', 'encoding:big5'])).toThrow('Ambiguous')
    expect(() => terminalEncodingFromTags(['encoding:latin1'])).toThrow('Unsupported')
  })
  it('allows Chinese descriptions while still refusing CLI injection and invisible direction controls', () => {
    expect(compileNetworkChanges(getNetworkProfile('huawei_vrp'), [{ kind: 'interface_description', target: 'GE1/0/1', value: '领益机房 核心-01' }])).toContain('description 领益机房 核心-01')
    for (const value of ['机房\nreboot', '机房;reboot', '机房\u202ereboot', '机房\u200breboot', '机房"']) expect(() => compileNetworkChanges(getNetworkProfile('huawei_vrp'), [{ kind: 'interface_description', target: 'GE1/0/1', value }])).toThrow()
  })
})
