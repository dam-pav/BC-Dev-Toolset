'use strict';

const net = require('node:net');
const tls = require('node:tls');

class DataTransportError extends Error {
  constructor(code, status = 0, receivedBytes = 0) {
    super(`BC Data HTTP transport: ${code}.`);
    this.name = 'DataTransportError';
    this.code = code;
    this.status = status;
    this.receivedBytes = receivedBytes;
    this.outcome = 'unknown';
  }
}

// Deliberately narrow HTTP/1.0, connection-close transport. No redirects, proxy,
// compression, connection reuse, retries, or private Node HTTP API overrides.
// Restricting response framing avoids the qualified HTTP.sys chunked-write defect.
function requestHttp10({ url, username, password, body, method = 'POST', timeoutMs = 30000,
  maxResponseBytes = 4 * 1024 * 1024, signal }) {
  let target;
  try { target = new URL(url); }
  catch { throw new Error('Invalid BC Data HTTP configuration.'); }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash ||
      !['GET', 'POST'].includes(method) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 16 * 1024 * 1024) {
    throw new Error('Invalid BC Data HTTP configuration.');
  }
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password || username.includes(':')) {
    throw new Error('BC Data requires configured UserPassword credentials.');
  }
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
  if (bytes.length > 4 * 1024 * 1024) throw new Error('BC Data request exceeds the 4 MiB limit.');
  const authorization = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  const header = Buffer.from(`${method} ${target.pathname}${target.search} HTTP/1.0\r\n` +
    `Host: ${target.host}\r\nAuthorization: Basic ${authorization}\r\n` +
    'Accept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n' +
    `Content-Type: application/json; charset=utf-8\r\nContent-Length: ${bytes.length}\r\n\r\n`, 'ascii');

  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    let status = 0;
    let responseHeaders;
    let headerBytes = Buffer.alloc(0);
    let received = 0;
    let expected = null;
    const chunks = [];
    const fail = code => finish(new DataTransportError(code, status, received));
    const abort = () => fail('cancelled');
    const timer = setTimeout(() => fail('timeout'), timeoutMs);
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket?.destroy();
      if (error) reject(error);
      else resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks, received) });
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    const acceptBody = chunk => {
      received += chunk.length;
      if (received > maxResponseBytes) { fail('response_too_large'); return; }
      if (expected !== null && received > expected) { fail('invalid_framing'); return; }
      chunks.push(chunk);
      if (expected !== null && received === expected) finish();
    };
    const accept = chunk => {
      if (settled) return;
      if (responseHeaders) { acceptBody(chunk); return; }
      headerBytes = Buffer.concat([headerBytes, chunk]);
      const boundary = headerBytes.indexOf('\r\n\r\n');
      if (boundary < 0) {
        if (headerBytes.length > 32768) fail('headers_too_large');
        return;
      }
      if (boundary > 32768) { fail('headers_too_large'); return; }
      const lines = headerBytes.subarray(0, boundary).toString('latin1').split('\r\n');
      const match = /^HTTP\/1\.[01] ([2-5][0-9]{2})(?: [\x20-\x7e]*)?$/.exec(lines.shift());
      if (!match) { fail('invalid_status'); return; }
      status = Number(match[1]);
      responseHeaders = Object.create(null);
      for (const line of lines) {
        const field = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line);
        if (!field) { fail('invalid_headers'); return; }
        const name = field[1].toLowerCase();
        if (Object.hasOwn(responseHeaders, name)) { fail('duplicate_headers'); return; }
        responseHeaders[name] = field[2].trim();
      }
      if (responseHeaders['transfer-encoding'] ||
          (responseHeaders['content-encoding'] && responseHeaders['content-encoding'] !== 'identity')) {
        fail('unsupported_framing'); return;
      }
      if (responseHeaders['content-length'] !== undefined) {
        if (!/^(0|[1-9][0-9]*)$/.test(responseHeaders['content-length'])) { fail('invalid_framing'); return; }
        expected = Number(responseHeaders['content-length']);
        if (!Number.isSafeInteger(expected) || expected > maxResponseBytes) { fail('response_too_large'); return; }
      }
      const remainder = headerBytes.subarray(boundary + 4);
      headerBytes = null;
      acceptBody(remainder);
    };
    try {
      const host = target.hostname.replace(/^\[|\]$/g, '');
      const options = { host, port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)) };
      const send = () => { socket.setNoDelay(true); socket.write(header); if (bytes.length) socket.write(bytes); };
      socket = target.protocol === 'https:'
        ? tls.connect({ ...options, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true }, send)
        : net.createConnection(options, send);
      socket.on('data', accept);
      socket.on('error', () => fail('connection_failure'));
      socket.on('end', () => {
        if (!responseHeaders || (expected !== null && received !== expected)) fail('incomplete_response');
        else finish();
      });
      socket.on('close', () => { if (!settled) fail('incomplete_response'); });
    } catch { fail('connection_failure'); }
  });
}

module.exports = { requestHttp10, DataTransportError };
