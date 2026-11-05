import type { ConnectConfig, KexAlgorithm } from 'ssh2'
import type { SshCompatibility } from '../../shared/networkDevice'
export type AlgorithmCategory = 'kex' | 'serverHostKey' | 'cipher' | 'hmac'
/** Only negotiation failures qualify. Authentication, network and trust errors never retry. */
export function failedAlgorithmCategory(error: unknown): AlgorithmCategory | null {
  if (!(error instanceof Error)) return null
  const match = /^Handshake failed: no matching (.+)$/i.exec(error.message)
  if (!match) return null
  if (/^key exchange algorithm$/i.test(match[1])) return 'kex'
  if (/^(?:host key format|server host key algorithm)$/i.test(match[1])) return 'serverHostKey'
  if (/^(?:(?:client->server|server->client|C->S|S->C) )?cipher$/i.test(match[1])) return 'cipher'
  if (/^(?:(?:client->server|server->client|C->S|S->C) )?(?:HMAC|MAC)$/i.test(match[1])) return 'hmac'
  return null
}
export function legacyAlgorithms(profile: SshCompatibility, categories: readonly AlgorithmCategory[]): ConnectConfig['algorithms'] {
  if (profile === 'strict') return undefined
  const result: NonNullable<ConnectConfig['algorithms']> = {}
  for (const category of categories) {
    if (category === 'kex') {
      const append: KexAlgorithm[] = ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1']
      if (profile === 'huawei-legacy') append.push('diffie-hellman-group1-sha1')
      result.kex = { append, prepend: [], remove: [] }
    }
    if (profile !== 'huawei-legacy') continue
    if (category === 'serverHostKey') result.serverHostKey = { append: ['ssh-rsa', 'ssh-dss'], prepend: [], remove: [] }
    if (category === 'cipher') result.cipher = { append: ['aes128-cbc', 'aes256-cbc', 'aes192-cbc', '3des-cbc', 'aes128-gcm', 'aes256-gcm'], prepend: [], remove: [] }
    if (category === 'hmac') result.hmac = { append: ['hmac-sha1', 'hmac-sha1-96', 'hmac-md5', 'hmac-md5-96', 'hmac-sha2-256-96', 'hmac-sha2-512-96', 'hmac-ripemd160'], prepend: [], remove: [] }
  }
  return Object.keys(result).length ? result : undefined
}
export async function withLegacySshRetry<T>(profile: SshCompatibility, open: (algorithms: ConnectConfig['algorithms']) => Promise<T>): Promise<T> {
  const enabled: AlgorithmCategory[] = []
  for (;;) {
    try { return await open(legacyAlgorithms(profile, enabled)) } catch (error) {
      const category = failedAlgorithmCategory(error)
      if (!category || profile === 'strict' || enabled.includes(category) || (profile === 'huawei-sha1' && category !== 'kex') || enabled.length >= 4) throw error
      enabled.push(category)
    }
  }
}
