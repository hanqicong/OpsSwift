import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync, readdirSync, statSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { NETWORK_PROFILES, getNetworkProfile, networkProfileFromTags, sshCompatibilityFromTags, compileNetworkChanges } from '../src/shared/networkDevice'
import { NetworkCli, normalizeCli, promptAtEnd, cliHasError, configHash, createNetworkPlan, getNetworkPlan, consumeNetworkPlan, buildNetworkCommands, verifyNetworkChanges, storeNetworkBackup, withNetworkLock, NETWORK_LIMITS } from '../src/main/services/networkCli'
import { failedAlgorithmCategory, legacyAlgorithms, withLegacySshRetry } from '../src/main/services/sshCompatibility'

class Stream extends EventEmitter {
  writes: string[] = []
  destroyed = false
  write(s: string): void { this.writes.push(s) }
  end(): void {}
  destroy(): void { this.destroyed = true }
}
describe('network adapter contract', () => {
  it('has unique profiles, literal read queries, and explicit write support', () => {
    expect(new Set(NETWORK_PROFILES.map((p) => p.id)).size).toBe(NETWORK_PROFILES.length)
    expect(NETWORK_PROFILES.length).toBe(22)
    for (const p of NETWORK_PROFILES) for (const q of Object.values(p.queries).filter(Boolean)) expect(q).not.toMatch(/[\n\r;&`]/)
    expect(getNetworkProfile('fortinet_fortios').style).toBeUndefined()
    expect(() => getNetworkProfile('unknown')).toThrow()
  })
  it('requires one human-selected profile and fails closed on ambiguity', () => {
    expect(networkProfileFromTags([])).toBeNull()
    expect(networkProfileFromTags(['network:huawei_vrp', 'network:configure'])?.id).toBe('huawei_vrp')
    expect(networkProfileFromTags(['network:huawei_vrp', 'network:cisco_ios'])).toBeNull()
    expect(sshCompatibilityFromTags(['ssh-compat:huawei-legacy', 'ssh-compat:huawei-sha1'])).toBe('strict')
  })
  it.each(['Gi1/0/1\nreboot', 'Gi1;reboot', '$(reboot)', 'Gi1|sh', '-option'])('rejects injected interface %s', (target) => {
    expect(() => compileNetworkChanges(getNetworkProfile('cisco_ios'), [{ kind: 'interface_description', target, value: 'Desk' }])).toThrow()
  })
  it.each(['x\nreload', 'x;reload', 'x`id`', 'x$HOME', 'x"'])('rejects injected description %s', (value) => {
    expect(() => compileNetworkChanges(getNetworkProfile('cisco_ios'), [{ kind: 'interface_description', target: 'Gi1/0/1', value }])).toThrow()
  })
  it('compiles vendor-specific commands and requires explicit Junos commit', () => {
    expect(buildNetworkCommands(getNetworkProfile('huawei_vrp'), [{ kind: 'interface_admin', target: 'GE1/0/1', value: 'up' }], false)).toEqual(['system-view', 'interface GE1/0/1', 'undo shutdown', 'quit', 'return'])
    expect(() => buildNetworkCommands(getNetworkProfile('juniper_junos'), [{ kind: 'interface_admin', target: 'ge-0/0/1', value: 'down' }], false)).toThrow()
    expect(buildNetworkCommands(getNetworkProfile('juniper_junos'), [{ kind: 'interface_admin', target: 'ge-0/0/1', value: 'down' }], true)).toEqual(['configure private', 'set interfaces ge-0/0/1 disable', 'commit check', 'commit and-quit'])
    expect(() => buildNetworkCommands(getNetworkProfile('fortinet_fortios'), [{ kind: 'interface_admin', target: 'port1', value: 'down' }], true)).toThrow()
  })
  it.each(['0', '4095', '01', '-1', '1;reload'])('refuses invalid VLAN %s', (target) => {
    expect(() => compileNetworkChanges(getNetworkProfile('h3c_comware'), [{ kind: 'vlan_name', target, value: 'Desk' }])).toThrow()
  })
  it('verifies the requested interface context, not a matching line on another interface', () => {
    const p = getNetworkProfile('huawei_vrp')
    const changes = [{ kind: 'interface_description' as const, target: 'GE1/0/1', value: 'Desk' }]
    expect(verifyNetworkChanges(p, 'interface GE1/0/2\n description Desk\n#\ninterface GE1/0/1\n description Other\n#', changes)[0].matched).toBe(false)
    expect(verifyNetworkChanges(p, 'interface GE1/0/1\n description Desk\n#', changes)[0].matched).toBe(true)
  })
})
describe('bounded network CLI', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  async function ready(): Promise<{ s: Stream; cli: NetworkCli }> {
    const s = new Stream(); const cli = new NetworkCli(s); const p = cli.ready(); s.emit('data', Buffer.from('<Switch>')); await vi.advanceTimersByTimeAsync(110); await p; return { s, cli }
  }
  it.each(['<Switch>', 'HRP_M<FW>', '[Switch-GE1/0/1]', 'switch(config-if)#', 'root@router>', '[admin@router] >', '(Controller) >', 'A:admin@router#'])('recognizes network prompt %s', (p) => expect(promptAtEnd(p)).toBe(p))
  it.each(['root@host:~#', 'user@host:~$', '$', 'regular text', '1.0.0'])('refuses non-network prompt %s', (p) => expect(promptAtEnd(p)).toBeNull())
  it('handles split prompts and command echo', async () => {
    const { s, cli } = await ready(); const p = cli.command('display version'); s.emit('data', Buffer.from('display version\r\nVRP V200\r\n<Sw')); s.emit('data', Buffer.from('itch>')); await vi.advanceTimersByTimeAsync(110); expect(await p).toBe('VRP V200'); cli.close(); expect(s.destroyed).toBe(true)
  })
  it('advances pagination in the same shell and retains all pages', async () => {
    const { s, cli } = await ready(); const p = cli.command('display interface'); s.emit('data', Buffer.from('display interface\r\nfirst\r\n---- More ----')); expect(s.writes.at(-1)).toBe(' '); s.emit('data', Buffer.from('\r\nsecond\r\n<Switch>')); await vi.advanceTimersByTimeAsync(110); expect(await p).toContain('second'); expect(await p).toContain('first'); cli.close()
  })
  it('refuses device errors instead of treating a returned prompt as success', async () => {
    const { s, cli } = await ready(); const p = cli.command('display bad'); const assertion = expect(p).rejects.toThrow('Device rejected'); s.emit('data', Buffer.from('Error: Unrecognized command\r\n<Switch>')); await vi.advanceTimersByTimeAsync(110); await assertion; cli.close()
  })
  it('does not answer an arbitrary confirmation', async () => {
    const { s, cli } = await ready(); const p = cli.command('display version'); const assertion = expect(p).rejects.toThrow('timed out'); s.emit('data', Buffer.from('Delete all configuration? [Y/N]')); expect(s.writes).toEqual(['display version\r']); await vi.advanceTimersByTimeAsync(NETWORK_LIMITS.commandMs + 1); await assertion; expect(s.destroyed).toBe(true)
  })
  it('aborts immediately without replaying a command', async () => {
    const s = new Stream(); const abort = new AbortController(); const cli = new NetworkCli(s, abort.signal); const p = cli.ready(); const assertion = expect(p).rejects.toThrow('cancelled'); abort.abort(); await assertion; expect(s.writes).toHaveLength(0)
  })
  it('refuses revoked authority before sending a command', async () => {
    const s = new Stream(); const cli = new NetworkCli(s, undefined, () => { throw new Error('revoked') }); const ready = cli.ready(); s.emit('data', '<Switch>'); await vi.advanceTimersByTimeAsync(110); await ready; await expect(cli.command('display version')).rejects.toThrow('revoked'); expect(s.writes).toHaveLength(0); cli.close()
  })
  it('recognizes common error families and strips terminal escapes', () => {
    expect(cliHasError('% Invalid input detected at ^ marker.')).toBe(true)
    expect(cliHasError('Command fail. Return code -61')).toBe(true)
    expect(normalizeCli('\x1b[31mVRP\x1b[0m\r\n')).toBe('VRP\n')
  })
})
describe('network plan binding, locking and protected artifacts', () => {
  const data = { sessionId: 'session', serverId: 'device', revision: 1, targetHash: 'target', profileId: 'huawei_vrp', beforeHash: 'before', commands: ['system-view'], changes: [], persist: false }
  it('binds plans to session/device/hash, expires them, and consumes once', () => {
    const p = createNetworkPlan(data, 100)
    expect(() => getNetworkPlan(p.id, p.hash, 'other', 'device', 101)).toThrow()
    expect(() => getNetworkPlan(p.id, 'wrong', 'session', 'device', 101)).toThrow()
    expect(() => getNetworkPlan(p.id, p.hash, 'session', 'other', 101)).toThrow()
    expect(() => getNetworkPlan(p.id, p.hash, 'session', 'device', 600101)).toThrow()
    expect(getNetworkPlan(p.id, p.hash, 'session', 'device', 101).commands).toEqual(['system-view'])
    consumeNetworkPlan(p.id)
    expect(() => getNetworkPlan(p.id, p.hash, 'session', 'device', 101)).toThrow()
    expect(getNetworkPlan(p.id, p.hash, 'session', 'device', 101, true).used).toBe(true)
    expect(() => consumeNetworkPlan(p.id)).toThrow()
  })
  it('does not let callers mutate an immutable stored plan', () => {
    const p = createNetworkPlan(data); p.commands.push('reboot'); expect(getNetworkPlan(p.id, p.hash, 'session', 'device').commands).not.toContain('reboot')
  })
  it('keeps a consumed plan verifiable when a later plan is created', () => {
    const first = createNetworkPlan(data); consumeNetworkPlan(first.id); createNetworkPlan(data)
    expect(getNetworkPlan(first.id, first.hash, 'session', 'device', Date.now(), true).used).toBe(true)
  })
  it('does not mistake an absent shutdown line for verified administrative-up state', () => {
    expect(verifyNetworkChanges(getNetworkProfile('huawei_vrp'), 'interface GE1/0/1\n description fixture\n#', [{ kind: 'interface_admin', target: 'GE1/0/1', value: 'up' }])[0].matched).toBe(false)
  })
  it('serializes a device and releases locks on failure', async () => {
    let release!: () => void
    const first = withNetworkLock('lock-test', () => new Promise<void>((r) => { release = r }))
    await expect(withNetworkLock('lock-test', async () => 1)).rejects.toThrow('active')
    release(); await first
    await expect(withNetworkLock('lock-test', async () => { throw new Error('fail') })).rejects.toThrow()
    expect(await withNetworkLock('lock-test', async () => 2)).toBe(2)
  })
  it('refuses configuration backup if OS encryption is unavailable', () => {
    const spy = vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false)
    expect(() => storeNetworkBackup('configuration')).toThrow('encryption'); spy.mockRestore()
  })
  it('writes and reads back a protected complete envelope, returns metadata only', () => {
    const result = storeNetworkBackup('interface GE1/0/1\n description fixture\n#')
    expect(Object.keys(result).sort()).toEqual(['bytes', 'encrypted', 'id', 'sha256'])
    const path = join(app.getPath('userData'), 'network-backups', `${result.id}.json`)
    expect(JSON.parse(readFileSync(path, 'utf8')).sha256).toBe(configHash('interface GE1/0/1\n description fixture\n#'))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(app.getPath('userData'), 'network-backups')).some((n) => n.endsWith('.pending'))).toBe(false)
  })
  it('tightens an existing backup directory to owner-only', () => {
    const dir = join(app.getPath('userData'), 'network-backups'); chmodSync(dir, 0o755); storeNetworkBackup('fixture')
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })
})
describe('per-connection legacy SSH negotiation', () => {
  it.each(['All configured authentication methods failed', 'Host denied (verification failed)', 'connect ECONNREFUSED', 'Timed out during the SSH handshake'])('does not retry %s', async (message) => {
    const open = vi.fn().mockRejectedValue(new Error(message)); await expect(withLegacySshRetry('huawei-legacy', open)).rejects.toThrow(message); expect(open).toHaveBeenCalledTimes(1)
  })
  it('keeps modern defaults first and enables only the failed category', async () => {
    const open = vi.fn().mockRejectedValueOnce(new Error('Handshake failed: no matching key exchange algorithm')).mockResolvedValue('ok')
    expect(await withLegacySshRetry('huawei-sha1', open)).toBe('ok'); expect(open.mock.calls[0][0]).toBeUndefined(); const algorithms = open.mock.calls[1][0]; expect(Object.keys(algorithms)).toEqual(['kex']); expect(algorithms.kex.append).not.toContain('diffie-hellman-group1-sha1'); expect(algorithms.kex.prepend).toEqual([])
  })
  it('bounds category retries and keeps strict mode strict', async () => {
    const open = vi.fn().mockRejectedValue(new Error('Handshake failed: no matching key exchange algorithm'))
    await expect(withLegacySshRetry('strict', open)).rejects.toThrow(); expect(open).toHaveBeenCalledTimes(1); open.mockClear()
    await expect(withLegacySshRetry('huawei-legacy', open)).rejects.toThrow(); expect(open).toHaveBeenCalledTimes(2)
  })
  it('only the explicit legacy profile allows CBC/Group1/DSA', () => {
    expect(legacyAlgorithms('huawei-sha1', ['cipher'])).toBeUndefined()
    expect(legacyAlgorithms('huawei-legacy', ['cipher', 'kex', 'serverHostKey'])).toMatchObject({ cipher: { append: ['aes128-cbc', 'aes256-cbc', 'aes192-cbc', '3des-cbc', 'aes128-gcm', 'aes256-gcm'] }, kex: { append: expect.arrayContaining(['diffie-hellman-group1-sha1']) }, serverHostKey: { append: ['ssh-rsa', 'ssh-dss'] } })
    expect(failedAlgorithmCategory(new Error('Handshake failed: no matching client->server HMAC'))).toBe('hmac')
  })
})
