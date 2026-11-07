/** Bounded USG V500R005 CLI candidate. No arbitrary commands, edits, deletions or rule reordering. */
export class UsgValidationError extends Error {}
export interface UsgAddressChange { kind: 'usg_address_set'; target: string; addresses: string[]; description?: string }
interface RuleMatch { target: string; sourceZone: string; destinationZone: string; sourceAddressSet: string; destinationAddressSet: string; description?: string }
export interface UsgSecurityChange extends RuleMatch { kind: 'usg_security_rule'; service: 'http' | 'https' | 'dns' | 'ssh' | 'ping'; action: 'permit' | 'deny' }
export interface UsgNatChange extends RuleMatch { kind: 'usg_nat_rule'; translation: 'easy-ip' | 'no-nat'; egressInterface?: string }
export type UsgChange = UsgAddressChange | UsgSecurityChange | UsgNatChange
export const USG_CHANGE_KINDS = ['usg_address_set', 'usg_security_rule', 'usg_nat_rule'] as const
export function isUsgChange(c: { kind: string }): c is UsgChange { return USG_CHANGE_KINDS.includes(c.kind as typeof USG_CHANGE_KINDS[number]) }
export function plainCliText(text: string): boolean { return /^[\p{L}\p{N}][\p{L}\p{N} _.:/-]{0,79}$/u.test(text) }
function name(text: string): void {
  if (typeof text !== 'string' || !/^[\p{L}\p{N}_][\p{L}\p{N}_.:/-]{0,31}$/u.test(text) || new TextEncoder().encode(text).length > 63 || /^(?:all|any|default)$/i.test(text)) throw new UsgValidationError('USG names need 1–32 literal letters, digits or name separators, at most 63 UTF-8 bytes; reserved names are refused')
}
function description(value: string | undefined): void { if (value !== undefined && !plainCliText(value)) throw new UsgValidationError('Invalid USG description') }
export function ipv4Subnet(cidr: string): { ip: string; prefix: number } {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/([1-9]|[12]\d|3[0-2])$/.exec(cidr)
  if (!m) throw new UsgValidationError('Use an explicit IPv4 subnet /1–/32')
  const parts = m[1].split('.').map(Number)
  if (parts.some((n, i) => n > 255 || String(n) !== m[1].split('.')[i])) throw new UsgValidationError('Invalid IPv4 subnet')
  const ip = parts.reduce((n, b) => ((n << 8) | b) >>> 0, 0), prefix = Number(m[2])
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  if (((ip & mask) >>> 0) !== ip) throw new UsgValidationError('Subnet has host bits set')
  return { ip: m[1], prefix }
}
export interface UsgBlock { header: string; lines: string[] }
/** Retain hierarchy: an identical rule name in NAT and security policy is a different object. */
export function usgBlocks(raw: string): UsgBlock[] {
  const result: UsgBlock[] = []
  let block: UsgBlock | undefined, policy = ''
  for (const rawLine of raw.replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim().replace(/^(ip address-set |rule name |firewall zone )"([^" ]+)"(?= |$)/, '$1$2')
    if (!line || line === '#') { if (line === '#') { block = undefined; policy = '' }; continue }
    if (/^(?:security-policy|nat-policy)$/.test(line)) { policy = line; block = undefined; continue }
    if (/^rule name /.test(line) && policy) { block = { header: `${policy}/${line}`, lines: [] }; result.push(block); continue }
    if (/^(?:ip address-set |firewall zone )/.test(line)) { policy = ''; block = { header: line, lines: [] }; result.push(block); continue }
    if (block && /^\s/.test(rawLine)) block.lines.push(line)
    else if (!(policy && /^\s/.test(rawLine))) { block = undefined; policy = '' }
  }
  return result
}
function addressName(b: UsgBlock): string | undefined { return /^ip address-set (\S+) type (?:object|group)$/.exec(b.header)?.[1] }
function ruleHeader(c: UsgSecurityChange | UsgNatChange): string { return `${c.kind === 'usg_security_rule' ? 'security-policy' : 'nat-policy'}/rule name ${c.target}` }
function unique(values: string[]): boolean { return new Set(values.map(x => x.toLocaleLowerCase('en-US'))).size === values.length }
export function usgAddressInventory(raw: string): { name: string; type: string; members: string[]; description?: string }[] {
  return usgBlocks(raw).filter(b => addressName(b)).map(b => ({ name: addressName(b)!, type: b.header.endsWith(' object') ? 'object' : 'group', members: b.lines.filter(l => /^address \d+ /.test(l)), ...(b.lines.find(l => l.startsWith('description ')) ? { description: b.lines.find(l => l.startsWith('description '))!.slice(12) } : {}) }))
}
/** Require explicit, consistent active/standby evidence; standalone is established by the complete baseline. */
export function assertUsgWritable(raw: string, version: string, ha: string, prompt: string): void {
  if (!/\bUSG\S*\s+V500R005C\d+/i.test(version)) throw new UsgValidationError('USG configuration is limited to the V500R005 candidate dialect')
  if (/(?:^|\n)\s*(?:vsys enable|vsys name |switch vsys )/i.test(raw)) throw new UsgValidationError('USG virtual systems require a dedicated qualified adapter')
  const enabled = /(?:^|\n)\s*hrp enable\s*(?:\n|$)/.test(raw)
  if (/^HRP_S/.test(prompt) || /\b(?:standby|abnormal|active-active)\b/i.test(ha.replace(/peer:\s*standby/i, ''))) throw new UsgValidationError('USG standby, abnormal or active-active operation is refused')
  if (enabled && (!/^HRP_M/.test(prompt) || !/Role:\s*active,\s*peer:\s*standby\b/i.test(ha))) throw new UsgValidationError('USG HA role is unknown or inconsistent')
  if (!enabled && (/^HRP_/.test(prompt) || /Role:\s*active/i.test(ha))) throw new UsgValidationError('USG HA state disagrees with its baseline')
}
function natVerb(raw: string): 'nat' | 'source-nat' {
  const actions = usgBlocks(raw).filter(b => b.header.startsWith('nat-policy/')).flatMap(b => b.lines).filter(l => /^action (?:nat|source-nat) /.test(l))
  const verbs = new Set(actions.map(l => l.split(' ')[1]))
  // V500R005 vendor interoperability example uses source-nat. Older NAT dialects require existing evidence.
  if (verbs.size > 1) throw new UsgValidationError('Mixed USG NAT dialects require manual qualification')
  return verbs.has('nat') ? 'nat' : 'source-nat'
}
function ruleLines(c: UsgSecurityChange | UsgNatChange, raw: string): string[] {
  const lines = [...(c.description ? [`description ${c.description}`] : []), `source-zone ${c.sourceZone}`, `destination-zone ${c.destinationZone}`, `source-address address-set ${c.sourceAddressSet}`, `destination-address address-set ${c.destinationAddressSet}`]
  if (c.kind === 'usg_security_rule') lines.push(`service ${c.service}`, `action ${c.action}`)
  else {
    if (c.egressInterface) lines.push(`egress-interface ${c.egressInterface}`)
    lines.push(c.translation === 'no-nat' ? 'action no-nat' : `action ${natVerb(raw)} easy-ip`)
  }
  return lines
}
export function compileUsgChanges(changes: readonly UsgChange[], raw: string): string[] {
  if (!raw.trim() || !changes.length || changes.length > 16) throw new UsgValidationError('USG changes require a complete baseline and 1–16 changes')
  if (!/(?:^|\n)\s*return\s*$/.test(raw)) throw new UsgValidationError('USG baseline is incomplete; the final return marker is required')
  const blocks = usgBlocks(raw), occupied = new Set(blocks.map(b => b.header.toLocaleLowerCase('en-US')))
  if (occupied.size !== blocks.length) throw new UsgValidationError('USG baseline has ambiguous duplicate object or rule headers')
  if (blocks.some(b => b.header.startsWith('ip address-set ') && !addressName(b))) throw new UsgValidationError('USG address header syntax is unqualified; object collision checks cannot be completed')
  const addresses = new Set(blocks.filter(b => b.header.endsWith(' type object') && b.lines.some(l => /^address \d+ /.test(l))).map(b => addressName(b)))
  const allAddresses = new Set(blocks.map(addressName).filter(Boolean).map(n => n!.toLocaleLowerCase('en-US')))
  const zones = new Set(['trust', 'untrust', 'dmz', ...blocks.filter(b => b.header.startsWith('firewall zone ')).map(b => b.header.slice(14))])
  const commands = ['system-view']
  for (const c of changes) {
    if (!isUsgChange(c)) throw new UsgValidationError('Only typed USG object and rule creation is supported')
    name(c.target); description(c.description)
    if (c.kind === 'usg_address_set') {
      if (allAddresses.has(c.target.toLocaleLowerCase('en-US'))) throw new UsgValidationError('USG address already exists; editing a referenced object is refused')
      if (!c.addresses.length || c.addresses.length > 16 || !unique(c.addresses)) throw new UsgValidationError('Address object needs 1–16 unique subnets')
      const members = c.addresses.map(ipv4Subnet)
      commands.push(`ip address-set ${c.target} type object`, ...(c.description ? [`description ${c.description}`] : []), ...members.map((a, i) => `address ${i} ${a.ip} mask ${a.prefix}`), 'quit')
      allAddresses.add(c.target.toLocaleLowerCase('en-US')); addresses.add(c.target)
    } else {
      const header = ruleHeader(c), key = header.toLocaleLowerCase('en-US')
      if (occupied.has(key)) throw new UsgValidationError('USG rule already exists; implicit replacement is refused')
      for (const value of [c.sourceZone, c.destinationZone, c.sourceAddressSet, c.destinationAddressSet]) name(value)
      if (c.sourceZone === 'local' || c.destinationZone === 'local' || !zones.has(c.sourceZone) || !zones.has(c.destinationZone)) throw new UsgValidationError('Select existing transit zones; Local/management policies are outside this adapter')
      if (!addresses.has(c.sourceAddressSet) || !addresses.has(c.destinationAddressSet)) throw new UsgValidationError('Rules require existing nonempty address objects or earlier objects in this plan')
      if (c.kind === 'usg_security_rule' && (!['http', 'https', 'dns', 'ssh', 'ping'].includes(c.service) || !['permit', 'deny'].includes(c.action))) throw new UsgValidationError('Unsupported USG service or action')
      if (c.kind === 'usg_nat_rule' && !['easy-ip', 'no-nat'].includes(c.translation)) throw new UsgValidationError('Unsupported USG NAT translation')
      if (c.kind === 'usg_nat_rule') {
        if (c.egressInterface !== undefined && (!/^[A-Za-z][A-Za-z0-9/_.:-]{0,79}$/.test(c.egressInterface) || !raw.split('\n').some(l => l.trim() === `interface ${c.egressInterface}`))) throw new UsgValidationError('NAT egress interface must already exist in the baseline')
        if (c.translation === 'no-nat' && c.egressInterface) throw new UsgValidationError('No-NAT rules do not accept an egress interface in this adapter')
        if (c.translation === 'easy-ip' && natVerb(raw) === 'nat' && !c.egressInterface) throw new UsgValidationError('Legacy action nat easy-ip requires an explicit existing egress interface')
      }
      commands.push(c.kind === 'usg_security_rule' ? 'security-policy' : 'nat-policy', `rule name ${c.target}`, ...ruleLines(c, raw), 'quit', 'quit')
      occupied.add(key)
    }
  }
  commands.push('return')
  return commands
}
function normalizedMember(line: string): string {
  return line.replace(/mask (\d+\.\d+\.\d+\.\d+)$/, (_, mask: string) => {
    const bits = mask.split('.').map(n => Number(n).toString(2).padStart(8, '0')).join('')
    return /^1+0*$/.test(bits) ? `mask ${bits.indexOf('0') < 0 ? 32 : bits.indexOf('0')}` : `mask ${mask}`
  })
}
export function verifyUsgChanges(raw: string, changes: readonly UsgChange[], before?: string): { kind: string; target: string; matched: boolean }[] {
  const blocks = usgBlocks(raw)
  return changes.map(c => {
    const header = c.kind === 'usg_address_set' ? `ip address-set ${c.target} type object` : ruleHeader(c)
    const matches = blocks.filter(b => b.header === header)
    const expected = c.kind === 'usg_address_set' ? [...(c.description ? [`description ${c.description}`] : []), ...c.addresses.map((s, i) => { const a = ipv4Subnet(s); return `address ${i} ${a.ip} mask ${a.prefix}` })] : ruleLines(c, before ?? raw)
    const actual = matches[0]?.lines.filter(l => !/^rule id \d+$/.test(l)).map(normalizedMember) ?? []
    return { kind: c.kind, target: c.target, matched: matches.length === 1 && actual.length === expected.length && expected.every(l => actual.includes(l)) }
  })
}
