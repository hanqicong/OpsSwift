// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { stubBridge } from './setup/renderer'
import { sshTransport } from '../src/renderer/src/lib/transport'
import type { Server } from '../src/renderer/src/types'

describe('terminal payload from saved connection settings', () => {
  it.each([['ssh', ['ssh-compat:huawei-sha1'], 'huawei-sha1'], ['telnet', ['transport:telnet'], 'strict']] as const)('passes %s and its compatibility policy through the renderer bridge', async (protocol, tags, compatibility) => {
    const connect = vi.fn().mockResolvedValue(undefined)
    stubBridge({ ssh: { connect } })
    const server = { id: 'fixture', name: 'Fixture', host: '192.0.2.1', port: protocol === 'telnet' ? 23 : 22, username: 'fixture', auth: 'password', route: [], tags: [...tags] } as unknown as Server
    await sshTransport(server, () => {}).connect('session', 120, 40)
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ remoteTransport: protocol, sshCompatibility: compatibility, serverId: 'fixture', cols: 120, rows: 40 }))
  })
})
