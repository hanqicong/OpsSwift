import { describe, expect, it } from 'vitest'
import { assertUsgWritable, compileUsgChanges, ipv4Subnet, usgAddressInventory, verifyUsgChanges, type UsgChange } from '../src/shared/huaweiUsg'
const baseline = '#\nhrp enable\n#\nip address-set 内网 type object\n address 0 10.20.0.0 mask 24\n#\nip address-set 服务器 type object\n address 0 192.0.2.10 mask 32\n#\nsecurity-policy\n default action permit\n rule name existing\n  action deny\n#\nnat-policy\n rule name existing\n  action nat easy-ip\n#\ninterface GigabitEthernet1/0/1\n#\nreturn'
const security: UsgChange = { kind: 'usg_security_rule', target: '业务HTTPS', sourceZone: 'trust', destinationZone: 'untrust', sourceAddressSet: '内网', destinationAddressSet: '服务器', service: 'https', action: 'permit', description: '业务访问' }
const nat: UsgChange = { kind: 'usg_nat_rule', target: '业务NAT', sourceZone: 'trust', destinationZone: 'untrust', sourceAddressSet: '内网', destinationAddressSet: '服务器', translation: 'easy-ip', egressInterface: 'GigabitEthernet1/0/1' }
const version = 'VRP (R) Software, Version 5.170 (USG6600 V500R005C20SPC500)'
describe('USG bounded configuration candidate', () => {
  it('compiles ordered typed object, security and NAT creation without replacing existing rules', () => {
    const changes: UsgChange[] = [{ kind: 'usg_address_set', target: '新应用', addresses: ['198.51.100.8/32'], description: '中文地址' }, { ...security, destinationAddressSet: '新应用' }, nat]
    const commands = compileUsgChanges(changes, baseline)
    expect(commands.indexOf('ip address-set 新应用 type object')).toBeLessThan(commands.indexOf('security-policy'))
    expect(commands).toContain('address 0 198.51.100.8 mask 32')
    expect(commands).toContain('action nat easy-ip')
    expect(commands).toContain('service https')
    expect(commands).not.toContain('save')
    expect(commands.at(-1)).toBe('return')
  })
  it('uses V500R005 source-nat for a new NAT policy and refuses mixed dialects', () => {
    expect(compileUsgChanges([nat], baseline.replace('action nat easy-ip', 'action source-nat easy-ip'))).toContain('action source-nat easy-ip')
    expect(() => compileUsgChanges([nat], baseline.replace('action nat easy-ip', 'action nat easy-ip\n  action source-nat easy-ip'))).toThrow('Mixed')
  })
  it('rejects collisions, unresolved references, Local-zone access, injection, duplicate members and wrong order', () => {
    for (const change of [{ ...security, target: 'existing' }, { ...security, sourceAddressSet: 'missing' }, { ...security, sourceZone: 'local' }, { ...security, target: '注入\nreboot' }, { ...security, service: 'any' }]) expect(() => compileUsgChanges([change as UsgChange], baseline)).toThrow()
    expect(() => compileUsgChanges([{ kind: 'usg_address_set', target: '内网', addresses: ['10.0.0.0/8'] }], baseline)).toThrow('already exists')
    expect(() => compileUsgChanges([{ kind: 'usg_address_set', target: 'new', addresses: ['10.0.0.0/8', '10.0.0.0/8'] }], baseline)).toThrow('unique')
    expect(() => compileUsgChanges([{ ...security, destinationAddressSet: 'new' }, { kind: 'usg_address_set', target: 'new', addresses: ['10.0.0.0/8'] }], baseline)).toThrow('require existing')
  })
  it.each(['0.0.0.0/0', '192.0.2.1/24', '256.0.0.0/8', '010.0.0.0/8', '10.0.0.0/33', '10.0.0.0/8\nreboot'])('refuses ambiguous or broad subnet %s', cidr => expect(() => ipv4Subnet(cidr)).toThrow())
  it('finds collisions after default policy settings or quoted names, and refuses incomplete baselines', () => {
    expect(() => compileUsgChanges([{ ...security, target: 'existing' }], baseline)).toThrow('already exists')
    expect(() => compileUsgChanges([{ ...security, target: 'existing' }], baseline.replace('rule name existing', 'rule name "existing"'))).toThrow('already exists')
    expect(() => compileUsgChanges([nat], baseline.replace('return', ''))).toThrow('incomplete')
  })
  it('checks firmware, HA role, peer and virtual system scope before writes', () => {
    expect(() => assertUsgWritable(baseline, version, 'Role: active, peer: standby', 'HRP_M<FW>')).not.toThrow()
    for (const ha of ['Role: standby, peer: active', 'Role: active, peer: active', 'Role: active, peer: standby (should be "active-active")', 'unknown']) expect(() => assertUsgWritable(baseline, version, ha, 'HRP_M<FW>')).toThrow()
    expect(() => assertUsgWritable(baseline, version.replace('V500R005', 'V600R007'), 'Role: active, peer: standby', 'HRP_M<FW>')).toThrow('V500R005')
    expect(() => assertUsgWritable(baseline + '\nvsys enable', version, 'Role: active, peer: standby', 'HRP_M<FW>')).toThrow('virtual')
    expect(() => assertUsgWritable(baseline.replace('hrp enable', ''), version, 'HRP is not enabled.', '<FW>')).not.toThrow()
  })
  it('returns only address inventory and keeps security/NAT namespaces distinct', () => {
    const raw = baseline + '\n#\naaa\n password cipher PRIVATE\n#'
    expect(usgAddressInventory(raw)).toHaveLength(2)
    expect(JSON.stringify(usgAddressInventory(raw))).not.toContain('PRIVATE')
    expect(verifyUsgChanges(baseline, [{ ...nat, target: 'existing' }])[0].matched).toBe(false)
  })
  it('verifies the exact rule fields and object members; extra match criteria are not accepted', () => {
    const raw = baseline + '\n#\nsecurity-policy\n rule name 业务HTTPS\n  description 业务访问\n  source-zone trust\n  destination-zone untrust\n  source-address address-set 内网\n  destination-address address-set 服务器\n  service https\n  action permit\n#'
    expect(verifyUsgChanges(raw, [security])[0].matched).toBe(true)
    expect(verifyUsgChanges(raw.replace('  service https', '  service https\n  source-address 0.0.0.0 mask 0'), [security])[0].matched).toBe(false)
    const address: UsgChange = { kind: 'usg_address_set', target: 'new', addresses: ['192.0.2.0/24'] }
    expect(verifyUsgChanges('#\nip address-set new type object\n address 0 192.0.2.0 mask 255.255.255.0\n#', [address])[0].matched).toBe(true)
  })
})
