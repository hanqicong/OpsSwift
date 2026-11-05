import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import en from '../src/shared/locales/en.json'
import zh from '../src/shared/locales/zh-CN.json'
import { DEFAULT_MCP_PORT } from '../src/shared/mcp'
import { MCP_SERVER_KEY } from '../src/shared/mcpClientKeys'
const read = (p: string) => readFileSync(resolve(p), 'utf8')
describe('OpsSwift LTS product contract', () => {
  it('has an independent product identity and retains the upstream licence', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg).toMatchObject({ name: 'opsswift', version: '1.0.0', productName: 'OpsSwift' })
    expect(read('electron-builder.yml')).toContain('appId: com.lyitech.opsswift')
    expect(read('LICENSE')).toContain('Copyright (c) 2026 OpsMaxx contributors')
  })
  it('supplies a Windows icon large enough to package', () => {
    const icon = readFileSync(resolve('build/icon.ico'))
    expect(icon.readUInt16LE(2)).toBe(1)
    expect(icon.readUInt16LE(4)).toBeGreaterThan(0)
    expect(icon[6] === 0 ? 256 : icon[6]).toBeGreaterThanOrEqual(256)
    expect(icon[7] === 0 ? 256 : icon[7]).toBeGreaterThanOrEqual(256)
  })
  it('preserves encrypted storage identity while keeping product data in a separate directory', () => {
    const portable = read('src/main/portable.ts')
    expect(portable).toContain("app.setName('OpsMaxx')")
    expect(portable).toContain("join(app.getPath('appData'), 'OpsSwift')")
    expect(DEFAULT_MCP_PORT).toBe(5177)
    expect(MCP_SERVER_KEY).toBe('opsmaxx')
  })
  it('covers every usable English message in Simplified Chinese with matching placeholders', () => {
    const chinese = zh as Record<string,string>
    const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1]).sort()
    for (const [key, value] of Object.entries(en)) {
      if (key.endsWith('_one')) continue // Chinese Intl.PluralRules always selects other.
      expect(chinese[key], key).toBeDefined()
      expect(vars(chinese[key]), key).toEqual(vars(value))
    }
  })
  it('keeps product updates on the managed OpsSwift release channel', () => {
    const updater = read('src/main/services/updater.ts')
    expect(updater).toContain('https://github.com/hanqicong/OpsSwift/releases/latest')
    expect(updater).toContain('managedReleaseUrl: RELEASES_URL')
    expect(updater).toContain('const NETWORK_EXTENSION_BUILD = true')
    expect(read('src/renderer/src/components/layout/TitleBar.tsx')).toContain("t('opsswift.productName')")
  })
})
