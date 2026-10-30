import { describe, expect, it, vi } from 'vitest'
import { NoReply, withFloodRetry, type CompanionLink } from './nodeCli'

const KEY = 'AB12CD34EF56' + '00'.repeat(26)

/** A companion that answers OK to everything and records what it was sent. */
function fakeCompanion() {
  const sent: number[] = []
  const c: CompanionLink = {
    exchange: async (frame) => {
      sent.push(frame[0]!)
      return new Uint8Array([0])
    },
    listen: () => () => {},
    waitFor: async () => null,
  }
  return { c, sent }
}

describe('withFloodRetry', () => {
  it('drops the path and floods once when a direct request goes unanswered', async () => {
    const { c, sent } = fakeCompanion()
    const onReset = vi.fn()
    const request = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new NoReply('pas de réponse du nœud', true))
      .mockResolvedValueOnce('OK')
    await expect(withFloodRetry(c, KEY, request, onReset)).resolves.toBe('OK')
    expect(sent).toEqual([13]) // CMD_RESET_PATH
    expect(onReset).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not retry a request that already went flood', async () => {
    const { c, sent } = fakeCompanion()
    const request = vi.fn<() => Promise<string>>().mockRejectedValue(new NoReply('pas de réponse du nœud', false))
    await expect(withFloodRetry(c, KEY, request)).rejects.toThrow('pas de réponse')
    expect(sent).toEqual([])
    expect(request).toHaveBeenCalledOnce()
  })

  it('does not retry other errors', async () => {
    const { c, sent } = fakeCompanion()
    const request = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('commande refusée par le compagnon'))
    await expect(withFloodRetry(c, KEY, request)).rejects.toThrow('refusée')
    expect(sent).toEqual([])
  })
})
