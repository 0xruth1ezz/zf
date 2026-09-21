const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { CookieJar, Cookie } = require('tough-cookie');
const { fetch, ProxyAgent } = require('undici');

const ORIGIN = 'https://www.zfrontier.com';
const SESSION_HEADERS = ['user-agent', 'accept-language', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'x-client-locale'];

class ZfError extends Error {
  constructor(message, { status, code, rejected = false } = {}) {
    super(message);
    Object.assign(this, { status, code, rejected });
  }
}

function credentialsKey(account) {
  return createHash('sha256').update(JSON.stringify([account.id, account.phone, account.password])).digest('hex');
}

class ZfHttpClient {
  constructor({ account, sessionFile, login, proxyUrl, signal, origin = ORIGIN, fetchImpl = fetch, now = Date.now, dayKey }) {
    Object.assign(this, { account, sessionFile, login, signal, origin, fetchImpl, now, dayKey });
    this.jar = new CookieJar();
    this.headers = {};
    this.csrf = '';
    this.validatedDay = '';
    this.blockedUntil = 0;
    this.clockOffset = 0;
    this.generation = 0;
    this.key = credentialsKey(account);
    this.dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
    try {
      const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      this.credentialsChanged = saved.key !== this.key;
      if (!this.credentialsChanged) {
        this.jar = CookieJar.deserializeSync(saved.jar);
        this.headers = saved.headers;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.credentialsChanged = true;
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.sessionFile}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ key: this.key, headers: this.headers, jar: this.jar.serializeSync() }), { mode: 0o600 });
      fs.renameSync(temporary, this.sessionFile);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  assertReady() {
    this.signal?.throwIfAborted();
    if (this.now() < this.blockedUntil) throw new ZfError('Account is waiting before retrying after a site/login error.', { rejected: true });
  }

  async bootstrap(forceLogin) {
    const session = await this.login(this.account, { forceLogin });
    this.signal?.throwIfAborted();
    this.headers = Object.fromEntries(SESSION_HEADERS.filter((key) => session.headers[key]).map((key) => [key, session.headers[key]]));
    if (!this.headers['user-agent']) throw new Error('Browser session did not supply a user agent.');
    this.jar = new CookieJar();
    for (const value of session.cookies) {
      const hostname = value.domain.replace(/^\./, '');
      if (hostname !== 'zfrontier.com' && !hostname.endsWith('.zfrontier.com')) continue;
      this.jar.setCookieSync(new Cookie({
        key: value.name, value: value.value, domain: hostname, path: value.path,
        secure: value.secure, httpOnly: value.httpOnly, hostOnly: !value.domain.startsWith('.'),
        expires: value.expires > 0 ? new Date(value.expires * 1000) : 'Infinity',
        sameSite: value.sameSite?.toLowerCase(),
      }), `https://${hostname}${value.path}`);
    }
    this.persist();
  }

  async raw(resource, { method = 'GET', fields, referer = '/app/' } = {}) {
    this.assertReady();
    const url = new URL(resource, this.origin);
    if (url.origin !== this.origin) throw new ZfError('Refusing a request outside zFrontier.', { rejected: true });
    const headers = { ...this.headers, accept: fields ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml',
      referer: new URL(referer, this.origin).href, cookie: this.jar.getCookieStringSync(url.href) };
    let body;
    if (fields) {
      headers.origin = this.origin;
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['x-csrf-token'] = this.csrf;
      headers['x-client-locale'] ||= 'en-US';
      const time = String(Math.floor((this.now() + this.clockOffset) / 1000));
      const t = createHash('md5').update(time + this.csrf).digest('hex');
      body = new URLSearchParams({ ...fields, time, t });
    }
    // A redirected mutation or an uncertain network response is never replayed.
    const response = await this.fetchImpl(url.href, { method, headers, body, redirect: 'manual',
      dispatcher: this.dispatcher, signal: AbortSignal.any([AbortSignal.timeout(20000), ...(this.signal ? [this.signal] : [])]) });
    for (const cookie of response.headers.getSetCookie()) this.jar.setCookieSync(cookie, url.href, { ignoreError: true });
    this.persist();
    const text = await response.text();
    if (response.status >= 300 && response.status < 400) {
      const target = new URL(response.headers.get('location') || '/', url);
      const login = target.origin === this.origin && /login/i.test(target.pathname);
      throw new ZfError(login ? 'Session requires login.' : 'Unexpected redirect from zFrontier.', { status: login ? 401 : response.status, rejected: method === 'GET' });
    }
    if (!response.ok) {
      if ([403, 429].includes(response.status)) this.blockedUntil = this.now() + 15 * 60000;
      throw new ZfError(`ZF request failed (HTTP ${response.status}).`, { status: response.status, rejected: [401, 403, 429].includes(response.status) });
    }
    if (method === 'GET' && url.pathname === '/app/') {
      const serverDate = Date.parse(response.headers.get('date'));
      if (Number.isFinite(serverDate)) this.clockOffset = serverDate - this.now();
    }
    return text;
  }

  async signed(resource, fields = {}, options = {}) {
    const text = await this.raw(resource, { ...options, method: 'POST', fields });
    let result;
    try { result = JSON.parse(text); } catch { throw new ZfError('ZF returned an unrecognized API response.'); }
    if (result.ok !== 0) {
      // The website also reports rate/verification failures with HTTP 200.
      if (result.ok === 20001) {
        this.blockedUntil = this.now() + 15 * 60000;
        // ZF uses this code for stale signatures as well as rate limiting.
        // Respect the cooldown, then retrieve a fresh token before retrying.
        this.validatedDay = '';
      }
      throw new ZfError(`ZF API rejected the request (code ${String(result.ok)}).`, { code: result.ok, rejected: true });
    }
    return result.data;
  }

  async validate() {
    const html = await this.raw('/app/');
    this.csrf = html.match(/(?:window\.)?csrf_token\s*=\s*["']([^"']+)["']/)?.[1] || '';
    if (!this.csrf) throw new ZfError('The session page did not supply a CSRF token.', { status: 401, rejected: true });
    await this.signed('/v2/signInfo');
    this.validatedDay = this.dayKey(new Date(this.now()));
    this.generation += 1;
  }

  async ensureSession() {
    this.assertReady();
    if (this.validatedDay === this.dayKey(new Date(this.now())) && this.csrf) return;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        if (!this.headers['user-agent']) await this.bootstrap(Boolean(this.credentialsChanged));
        try { await this.validate(); } catch (error) {
          if (error.status !== 401) throw error;
          await this.bootstrap(true);
          await this.validate();
        }
      })().catch((error) => {
        this.blockedUntil = Math.max(this.blockedUntil, this.now() + 60000);
        throw error;
      }).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async authenticated(operation) {
    await this.ensureSession();
    const generation = this.generation;
    try { return await operation(); } catch (error) {
      if (error.status !== 401) throw error;
      if (this.generation === generation) this.validatedDay = '';
      await this.ensureSession();
      return operation(); // Only an explicit unauthenticated response permits a retry.
    }
  }

  api(resource, fields = {}, options = {}) {
    return this.authenticated(() => this.signed(resource, fields, options));
  }

  html(resource) { return this.authenticated(() => this.raw(resource)); }
  async close() { await this.dispatcher?.close(); }
}

module.exports = { ORIGIN, ZfError, ZfHttpClient, credentialsKey };
