import { describe, expect, it } from 'vitest'
import { payloadFamily, payloadTitle } from './payload'

describe('payloadFamily', () => {
  it('groups the firmware payload types into families', () => {
    expect(payloadFamily('TXT_MSG')).toBe('message')
    expect(payloadFamily('ACK')).toBe('request')
    expect(payloadFamily('TRACE')).toBe('routing')
    expect(payloadFamily('GRP_DATA')).toBe('data')
  })

  it('puts an unknown type in data and still titles it', () => {
    expect(payloadFamily('UNKNOWN_12')).toBe('data')
    expect(payloadTitle('UNKNOWN_12')).toBe('Données')
    expect(payloadTitle('TRACE')).toBe('Routage — Trace : SNR relevé à chaque saut')
  })
})
