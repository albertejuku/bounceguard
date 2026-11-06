// Where a domain's mail goes. Handles null MX (RFC 7505: "this domain takes no mail") and the implicit MX of
// RFC 5321 section 5.1 (no MX record, but the domain's own address takes mail). A failed lookup is reported as
// an error, never as "no mail server", so a flaky resolver can't get good addresses marked undeliverable.
import { Resolver } from 'node:dns/promises';

export function createResolver({ timeout = 5000, tries = 2, servers } = {}) {
  const resolver = new Resolver({ timeout, tries });
  if (servers?.length) resolver.setServers(servers);
  return resolver;
}

const ABSENT = new Set(['ENODATA', 'ENOTFOUND']);

/**
 * Returns { status, hosts, implicit?, error? } where status is
 * 'ok' | 'null_mx' | 'no_domain' | 'no_mail' | 'error', and hosts is [{ exchange, priority }] sorted by priority.
 */
export async function lookupMail(domain, resolver) {
  let records;
  try {
    records = await resolver.resolveMx(domain);
  } catch (err) {
    if (err?.code === 'ENOTFOUND') return { status: 'no_domain', hosts: [] };
    if (err?.code !== 'ENODATA') {
      // Some resolvers (home routers especially) time out on MX queries for names that don't exist but answer
      // an A query with a definite NXDOMAIN. Only that definite answer turns a failure into "no domain".
      const missing = await resolver.resolve4(domain).then(() => false, (e) => e?.code === 'ENOTFOUND');
      if (missing) return { status: 'no_domain', hosts: [] };
      return { status: 'error', hosts: [], error: err?.code || String(err?.message || err) };
    }
    records = [];
  }

  if (records.length === 1 && (records[0].exchange === '' || records[0].exchange === '.')) {
    return { status: 'null_mx', hosts: [] };
  }
  const hosts = records
    .filter((r) => r.exchange && r.exchange !== '.')
    .map((r) => ({ exchange: r.exchange.replace(/\.$/, '').toLowerCase(), priority: Number(r.priority) || 0 }))
    .sort((a, b) => a.priority - b.priority);
  if (hosts.length) return { status: 'ok', hosts, implicit: false };

  const lookups = await Promise.allSettled([resolver.resolve4(domain), resolver.resolve6(domain)]);
  if (lookups.some((r) => r.status === 'fulfilled' && r.value.length > 0)) {
    return { status: 'ok', hosts: [{ exchange: domain, priority: 0 }], implicit: true };
  }
  const failed = lookups.find((r) => r.status === 'rejected' && !ABSENT.has(r.reason?.code));
  if (failed) return { status: 'error', hosts: [], error: failed.reason?.code || String(failed.reason?.message) };
  return { status: 'no_mail', hosts: [] };
}
