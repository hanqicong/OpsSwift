import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { parseSshCompatibility, sshCompatibilityFromTags } from '../src/shared/networkDevice'
import { refreshMcpDataCache, getCachedServer, serverToSshConfig } from '../src/main/services/mcpDataCache'
import { defaultSshCompatibility } from '../src/main/services/sshPolicy'
import { resolveChainSecrets } from '../src/main/services/credentialResolver'
import type { SshHop } from '../src/shared/ssh'
import { legacyAlgorithms } from '../src/main/services/sshCompatibility'

const server = (id: string, tags: string[] = []) => ({ id, workspaceId: 'ws', name: id, host: '192.0.2.1', port: 22, username: 'fixture', auth: 'agent', route: [], tags })
afterEach(() => refreshMcpDataCache({}))
describe('human-owned global SSH compatibility', () => {
  it('defaults fresh or malformed settings to strict', () => {
    for (const settings of [undefined, {}, { sshCompatibilityDefault: 'unknown' }, { sshCompatibilityDefault: true }]) {
      refreshMcpDataCache({ settings }); expect(defaultSshCompatibility()).toBe('strict')
    }
    expect(parseSshCompatibility(null)).toBe('strict')
  })
  it('applies a saved global policy to multiple existing/new servers and unsaved jump hops', () => {
    refreshMcpDataCache({ settings: { sshCompatibilityDefault: 'huawei-legacy' }, servers: [server('a'), server('b')] })
    for (const id of ['a', 'b']) expect(serverToSshConfig(getCachedServer(id)!).sshCompatibility).toBe('huawei-legacy')
    const cfg = resolveChainSecrets<SshHop & { hops: SshHop[] }>({ host: '192.0.2.3', port: 22, username: 'fixture', auth: 'agent' as const, hops: [{ host: '192.0.2.2', port: 22, username: 'fixture', auth: 'agent' as const }] })
    expect(cfg.sshCompatibility).toBe('huawei-legacy'); expect(cfg.hops![0].sshCompatibility).toBe('huawei-legacy')
  })
  it('keeps explicit strict/limited policies and refuses conflicting or unknown per-device tags', () => {
    expect(sshCompatibilityFromTags([], 'huawei-legacy')).toBe('huawei-legacy')
    for (const tags of [['ssh-compat:strict'], ['ssh-compat:unknown'], ['ssh-compat:huawei-legacy','ssh-compat:huawei-sha1']]) expect(sshCompatibilityFromTags(tags, 'huawei-legacy')).toBe('strict')
    expect(sshCompatibilityFromTags(['ssh-compat:huawei-sha1'], 'huawei-legacy')).toBe('huawei-sha1')
    refreshMcpDataCache({ settings: { sshCompatibilityDefault: 'huawei-legacy' }, servers: [server('strict', ['ssh-compat:strict'])] })
    expect(serverToSshConfig(getCachedServer('strict')!).sshCompatibility).toBe('strict')
  })
  it('covers every non-default algorithm supported by the installed SSH runtime, without putting old algorithms first', () => {
    const constants = createRequire(import.meta.url)('ssh2/lib/protocol/constants') as Record<string, string[]>
    for (const [field, name] of [['kex', 'KEX'], ['serverHostKey', 'SERVER_HOST_KEY'], ['cipher', 'CIPHER'], ['hmac', 'MAC']] as const) {
      const options = legacyAlgorithms('huawei-legacy', [field])![field] as { append: string[]; prepend: string[] }
      for (const algorithm of constants['SUPPORTED_' + name].filter(a => !constants['DEFAULT_' + name].includes(a))) expect(options.append, field).toContain(algorithm)
      expect(options.prepend).toEqual([])
    }
  })
})
