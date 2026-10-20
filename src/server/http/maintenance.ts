import { ApiError } from '@/lib/errors';

/**
 * Maintenance mode: pause writes, keep reads working.
 *
 * DEPLOY_RUNBOOK §8 backs up by pausing writes while the database and the
 * media directory are copied. The database snapshot can be taken consistently
 * with SQLite's online backup API while the service is running, but the media
 * copy cannot: an upload that lands between the two copies leaves the
 * snapshot with a row but no file, or with a file no row refers to. The
 * manifest check at the end of the backup then rejects the snapshot -- or, if
 * the order happens to fall the other way, the backup silently omits a
 * photograph. Neither is acceptable for the one artefact that cannot be
 * regenerated.
 *
 * The flag lives in the process, which is the right scope for this
 * deployment: one Node process behind nginx (DEPLOY_RUNBOOK §4). A
 * multi-instance deployment would need shared state, and the pause would have
 * to be pushed to every instance.
 *
 * Reads are unaffected on purpose. A maintenance window that took the whole
 * site down would turn a two-minute backup into an outage, and the point of
 * the pause is to make the *data* stable, not to make the site unreachable.
 */

/** True while writes are paused. */
let writesPaused = false;

/** Whether writes are currently paused. */
export function areWritesPaused(): boolean {
  return writesPaused;
}

/**
 * Turn the pause on or off.
 *
 * Returns the state before the change, so the caller can tell whether it was
 * the one that actually paused the site.
 */
export function setWritesPaused(paused: boolean): boolean {
  const previous = writesPaused;
  writesPaused = paused;
  return previous;
}

/**
 * Refuse a write while the site is paused.
 *
 * Called from the single place every mutating route passes through, so no
 * handler can forget it. A 503 with a clear message is the right answer: the
 * client should retry later, and the operator should be able to tell this
 * apart from a storage fault.
 */
export function requireWritesAllowed(): void {
  if (!writesPaused) return;
  throw ApiError.serviceUnavailable('站点正在维护，写入暂时不可用，请稍后再试');
}

/**
 * Is this address one of the machine's own?
 *
 * Node reports an IPv4 socket as the IPv4-mapped IPv6 address, so both forms
 * have to be recognised.
 */
function isLoopbackAddress(value: string): boolean {
  const address = value.trim().toLowerCase();
  if (address === '' || address === '::1' || address === '0:0:0:0:0:0:0:1') return true;
  if (address.startsWith('::ffff:')) return isLoopbackAddress(address.slice('::ffff:'.length));
  return address === '127.0.0.1' || address.startsWith('127.');
}

/**
 * Is this request coming from the machine itself?
 *
 * The pause endpoint is unauthenticated -- it is an operator tool, not a user
 * feature -- so it must not be reachable from the network. Two conditions
 * together are enough:
 *
 *   - the Host is a loopback name, and
 *   - the outermost hop that saw this request was the machine itself.
 *
 * The second condition is read from the *last* entry of X-Forwarded-For. That
 * entry is the one the outermost proxy added, so it cannot be forged by a
 * client: nginx appends the address it saw, and it appends it last. Reading
 * the first entry instead would be forgeable, because a client may send its
 * own X-Forwarded-For and nginx would prepend it to the list.
 *
 * The header is always present, incidentally: Next.js fills it with the
 * socket's remote address when the request did not arrive through a proxy
 * (base-server.js), so a direct connection reports the loopback address and
 * a proxied one reports the client.
 */
export function isLoopbackRequest(request: Request): boolean {
  const host = request.headers.get('host');
  if (host === null || host === '') return false;

  // Strip the port, taking care of the bracketed IPv6 form.
  const name = host.startsWith('[')
    ? host.slice(1, host.indexOf(']') === -1 ? undefined : host.indexOf(']'))
    : (host.split(':')[0] ?? '');
  if (!isLoopbackAddress(name) && name !== 'localhost') return false;

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded === null) return true;

  const hops = forwarded
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop !== '');
  const outermost = hops[hops.length - 1];
  return outermost !== undefined && isLoopbackAddress(outermost);
}
