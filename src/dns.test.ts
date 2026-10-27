import { describe, it, expect } from 'vitest'
import { parseResolvConf } from './dns'

describe('parseResolvConf', () => {
  it('skips a loopback forwarder listed ahead of the real resolver', () => {
    expect(parseResolvConf('nameserver 127.0.0.100\nnameserver 168.63.129.16\n')).toEqual({
      nameservers: ['168.63.129.16'],
      hasStubResolver: true
    })
  })

  it('treats all of 127.0.0.0/8, ::1 and IPv4-mapped loopback as loopback', () => {
    for (const ns of [
      '127.0.0.1', '127.0.0.53', '127.0.0.100', '127.255.255.254',
      '::1', '0::1', '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1'
    ]) {
      expect(parseResolvConf(`nameserver ${ns}\n`), ns).toEqual({ nameservers: [], hasStubResolver: true })
    }
  })

  it('keeps real resolvers, including ones that merely look close to loopback', () => {
    expect(parseResolvConf('nameserver 128.0.0.1\nnameserver 10.127.0.1\nnameserver 2001:db8::1\n')).toEqual({
      nameservers: ['128.0.0.1', '10.127.0.1', '2001:db8::1'],
      hasStubResolver: false
    })
  })
})
