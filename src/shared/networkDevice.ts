/** Network profiles are selected by a person in the connection editor, never by an MCP caller. */
export type NetworkQuery = 'version' | 'interfaces' | 'vlans' | 'routes' | 'neighbors' | 'arp' | 'mac' | 'ha' | 'cpu' | 'memory'
export type ConfigStyle = 'vrp' | 'ios' | 'junos'
export interface NetworkProfile {
  id: string
  label: string
  family: string
  paging: string[]
  queries: Partial<Record<NetworkQuery, string>>
  backup: string
  style?: ConfigStyle
  enter?: string
  leave?: string
  save?: string
}
const ios = { version: 'show version', interfaces: 'show interfaces', vlans: 'show vlan brief', routes: 'show ip route', neighbors: 'show lldp neighbors', arp: 'show ip arp', mac: 'show mac address-table' }
const vrp = { version: 'display version', interfaces: 'display interface brief', vlans: 'display vlan', routes: 'display ip routing-table', neighbors: 'display lldp neighbor brief', arp: 'display arp', mac: 'display mac-address', cpu: 'display cpu-usage', memory: 'display memory-usage' }
function profile(id: string, label: string, family: string, paging: string[], queries: NetworkProfile['queries'], backup: string, config?: Pick<NetworkProfile, 'style' | 'enter' | 'leave' | 'save'>): NetworkProfile {
  return { id, label, family, paging, queries, backup, ...config }
}
const iosConfig = { style: 'ios' as const, enter: 'configure terminal', leave: 'end', save: 'write memory' }
const vrpConfig = { style: 'vrp' as const, enter: 'system-view', leave: 'return', save: 'save' }
/** These are candidate adapters, NOT a claim of hardware/firmware certification. */
export const NETWORK_PROFILES: readonly NetworkProfile[] = [
  profile('huawei_vrp', 'Huawei VRP / S / CloudEngine', 'Huawei', ['screen-length 0 temporary'], vrp, 'display current-configuration', vrpConfig),
  profile('huawei_usg', 'Huawei USG', 'Huawei', ['screen-length 0 temporary'], { version: vrp.version, interfaces: vrp.interfaces, ha: 'display hrp state', cpu: vrp.cpu, memory: vrp.memory }, 'display current-configuration'),
  profile('huawei_wlan', 'Huawei WLAN AC', 'Huawei', ['screen-length 0 temporary'], { version: 'display version', interfaces: 'display interface brief', neighbors: 'display ap all' }, 'display current-configuration'),
  profile('h3c_comware', 'H3C / HPE Comware', 'H3C', ['screen-length disable'], vrp, 'display current-configuration', { ...vrpConfig, save: 'save force' }),
  profile('cisco_ios', 'Cisco IOS / IOS XE', 'Cisco', ['terminal length 0', 'terminal width 511'], ios, 'show running-config', iosConfig),
  profile('cisco_nxos', 'Cisco NX-OS', 'Cisco', ['terminal length 0', 'terminal width 511'], ios, 'show running-config', { ...iosConfig, save: 'copy running-config startup-config' }),
  profile('cisco_iosxr', 'Cisco IOS XR', 'Cisco', ['terminal length 0'], { ...ios, routes: 'show route', vlans: undefined }, 'show running-config'),
  profile('cisco_asa', 'Cisco ASA', 'Cisco', ['terminal pager 0'], { version: 'show version', interfaces: 'show interface ip brief', routes: 'show route', arp: 'show arp', ha: 'show failover' }, 'show running-config'),
  profile('cisco_wlc', 'Cisco AireOS WLC', 'Cisco', [], { version: 'show sysinfo', interfaces: 'show interface summary', neighbors: 'show ap summary' }, 'show run-config commands'),
  profile('juniper_junos', 'Juniper Junos', 'Juniper', ['set cli screen-length 0', 'set cli screen-width 511'], { version: 'show version', interfaces: 'show interfaces terse', vlans: 'show vlans', routes: 'show route', neighbors: 'show lldp neighbors', arp: 'show arp', ha: 'show chassis cluster status' }, 'show configuration | display set', { style: 'junos', enter: 'configure private', leave: 'exit' }),
  profile('arista_eos', 'Arista EOS', 'Arista', ['terminal length 0', 'terminal width 511'], ios, 'show running-config', iosConfig),
  profile('ruijie_os', 'Ruijie RGOS', 'Ruijie', ['terminal length 0'], ios, 'show running-config', iosConfig),
  profile('aruba_aoscx', 'Aruba AOS-CX', 'Aruba', ['no page'], { ...ios, interfaces: 'show interface brief', vlans: 'show vlan', routes: 'show ip route', arp: 'show arp' }, 'show running-config', { ...iosConfig, save: 'copy running-config startup-config' }),
  profile('aruba_osswitch', 'Aruba / HPE ProCurve', 'Aruba', ['no page'], { version: 'show version', interfaces: 'show interfaces brief', vlans: 'show vlans', routes: 'show ip route', neighbors: 'show lldp info remote-device', arp: 'show arp' }, 'show running-config'),
  profile('fortinet_fortios', 'Fortinet FortiOS', 'Fortinet', [], { version: 'get system status', interfaces: 'get system interface', routes: 'get router info routing-table all', arp: 'get system arp', ha: 'get system ha status', cpu: 'get system performance status' }, 'show full-configuration'),
  profile('paloalto_panos', 'Palo Alto PAN-OS', 'Palo Alto', ['set cli pager off'], { version: 'show system info', interfaces: 'show interface all', routes: 'show routing route', arp: 'show arp all', ha: 'show high-availability state' }, 'show config running'),
  profile('mikrotik_routeros', 'MikroTik RouterOS', 'MikroTik', [], { version: '/system resource print', interfaces: '/interface print detail without-paging', routes: '/ip route print without-paging', neighbors: '/ip neighbor print without-paging', arp: '/ip arp print without-paging' }, '/export'),
  profile('dell_os10', 'Dell OS10', 'Dell', ['terminal length 0'], ios, 'show running-configuration'),
  profile('extreme_exos', 'Extreme EXOS', 'Extreme', ['disable clipaging'], { version: 'show version', interfaces: 'show ports information', vlans: 'show vlan', routes: 'show iproute', neighbors: 'show lldp neighbors', arp: 'show iparp' }, 'show configuration'),
  profile('ruckus_fastiron', 'Ruckus / Brocade FastIron', 'Ruckus', ['skip-page-display'], ios, 'show running-config'),
  profile('huawei_vrp8', 'Huawei VRP8 candidate / commit', 'Huawei', ['screen-length 0 temporary'], vrp, 'display current-configuration'),
  profile('nokia_sros', 'Nokia SR OS classic CLI', 'Nokia', ['environment no more'], { version: 'show version', interfaces: 'show port', routes: 'show router route-table', arp: 'show router arp' }, 'admin display-config')
]
export function getNetworkProfile(id: string): NetworkProfile {
  const p = NETWORK_PROFILES.find((x) => x.id === id)
  if (!p) throw new Error('Unknown network profile')
  return p
}
export function networkProfileFromTags(tags: readonly string[] = []): NetworkProfile | null {
  const ids = tags.filter((x) => x.startsWith('network:') && x !== 'network:configure').map((x) => x.slice(8))
  if (ids.length !== 1) return null
  return NETWORK_PROFILES.find((x) => x.id === ids[0]) ?? null
}
export type SshCompatibility = 'strict' | 'huawei-sha1' | 'huawei-legacy'
export function parseSshCompatibility(value: unknown): SshCompatibility {
  return value === 'huawei-sha1' || value === 'huawei-legacy' ? value : 'strict'
}
export function sshCompatibilityFromTags(tags: readonly string[] = [], fallback: SshCompatibility = 'strict'): SshCompatibility {
  const selected = tags.filter((x) => x.startsWith('ssh-compat:'))
  if (selected.length === 0) return fallback
  if (selected.length !== 1) return 'strict'
  return selected[0] === 'ssh-compat:huawei-sha1' ? 'huawei-sha1' : selected[0] === 'ssh-compat:huawei-legacy' ? 'huawei-legacy' : 'strict'
}
export interface NetworkChange {
  kind: 'interface_description' | 'interface_admin' | 'vlan_name' | 'access_vlan'
  target: string
  value: string
}
export function compileNetworkChanges(p: NetworkProfile, changes: readonly NetworkChange[]): string[] {
  if (!p.style || !p.enter || !p.leave) throw new Error('This adapter supports read-only operations; configuration has not been enabled')
  if (!changes.length || changes.length > 16) throw new Error('A plan needs 1–16 changes')
  const commands: string[] = [p.enter]
  for (const c of changes) {
    if (!/^[A-Za-z][A-Za-z0-9/_.:-]{0,79}$/.test(c.target) && c.kind !== 'vlan_name') throw new Error('Invalid interface name')
    if (c.kind === 'vlan_name' || c.kind === 'access_vlan') {
      const vlan = c.kind === 'vlan_name' ? c.target : c.value
      if (!/^[1-9]\d{0,3}$/.test(vlan) || Number(vlan) > 4094) throw new Error('VLAN must be between 1 and 4094')
    }
    if (c.kind === 'interface_description' || c.kind === 'vlan_name') {
      if (!/^[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,79}$/.test(c.value)) throw new Error('Description/name must be 1–80 plain characters')
    }
    if (c.kind === 'interface_admin' && !['up', 'down'].includes(c.value)) throw new Error('Interface state must be up or down')
    if (p.style === 'junos') {
      if (c.kind !== 'interface_description' && c.kind !== 'interface_admin') throw new Error('Junos adapter supports interface description/admin only')
      commands.push(c.kind === 'interface_description' ? `set interfaces ${c.target} description "${c.value}"` : `${c.value === 'down' ? 'set' : 'delete'} interfaces ${c.target} disable`)
      continue
    }
    commands.push(c.kind === 'vlan_name' ? `vlan ${c.target}` : `interface ${c.target}`)
    if (c.kind === 'interface_description') commands.push(`description ${c.value}`)
    if (c.kind === 'interface_admin') commands.push(c.value === 'down' ? 'shutdown' : p.style === 'vrp' ? 'undo shutdown' : 'no shutdown')
    if (c.kind === 'vlan_name') commands.push(`${p.id === 'h3c_comware' ? 'name' : p.style === 'vrp' ? 'description' : 'name'} ${c.value}`)
    if (c.kind === 'access_vlan') commands.push(p.id === 'h3c_comware' ? `port access vlan ${c.value}` : p.id === 'aruba_aoscx' ? `vlan access ${c.value}` : p.style === 'vrp' ? `port default vlan ${c.value}` : `switchport access vlan ${c.value}`)
    commands.push(p.style === 'vrp' ? 'quit' : 'exit')
  }
  commands.push(...(p.style === 'junos' ? ['commit check', 'commit and-quit'] : [p.leave]))
  return commands
}
