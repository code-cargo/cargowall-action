import { describe, it, expect } from 'vitest'
import { parseResolvConf, proxyResolvConf } from './dns'

describe('parseResolvConf', () => {
  it('skips a loopback forwarder listed ahead of the real resolver', () => {
    expect(parseResolvConf('nameserver 127.0.0.100\nnameserver 168.63.129.16\n')).toEqual({
      nameservers: ['168.63.129.16'],
      hasStubResolver: true
    })
  })

  it('treats all of 127.0.0.0/8, ::1 and IPv4-mapped loopback as loopback', () => {
    for (const ns of ['127.0.0.1', '127.0.0.53', '127.0.0.100', '127.255.255.254', '::1', '::ffff:127.0.0.1']) {
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

describe('proxyResolvConf', () => {
  it('carries the search list across the DNS repoint (#84)', () => {
    expect(
      proxyResolvConf('nameserver 1.1.1.1\nsearch corp.lan\noptions ndots:5\n')
    ).toBe('nameserver 127.0.0.1\nsearch corp.lan\n')
  })

  it('carries a `domain` directive, which glibc and cargowall read the same way', () => {
    expect(proxyResolvConf('domain corp.lan\nnameserver 1.1.1.1\n')).toBe(
      'nameserver 127.0.0.1\ndomain corp.lan\n'
    )
  })

  it('keeps every directive in order, leaving last-wins to the readers', () => {
    // glibc and cargowall both take the last one; dropping the earlier lines
    // here would be this action deciding that on their behalf.
    expect(proxyResolvConf('search a.lan\nsearch b.lan\n')).toBe(
      'nameserver 127.0.0.1\nsearch a.lan\nsearch b.lan\n'
    )
  })

  it('drops the original nameservers — the proxy is the only one left', () => {
    expect(proxyResolvConf('nameserver 8.8.8.8\nnameserver 8.8.4.4\n')).toBe(
      'nameserver 127.0.0.1\n'
    )
  })

  it('does not carry resolver options', () => {
    // Not what cargowall reads.
    expect(proxyResolvConf('options ndots:5 trust-ad\nsearch corp.lan\n')).toBe(
      'nameserver 127.0.0.1\nsearch corp.lan\n'
    )
  })

  it('ignores a bare directive with no suffix after it', () => {
    expect(proxyResolvConf('search\nsearch   \n')).toBe('nameserver 127.0.0.1\n')
  })

  it('normalises leading and trailing whitespace on a carried line', () => {
    expect(proxyResolvConf('   search corp.lan   \n')).toBe(
      'nameserver 127.0.0.1\nsearch corp.lan\n'
    )
  })

  it('writes just the proxy when there was no resolv.conf to read', () => {
    expect(proxyResolvConf(null)).toBe('nameserver 127.0.0.1\n')
  })
})
