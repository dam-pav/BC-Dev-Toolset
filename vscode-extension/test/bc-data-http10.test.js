'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { requestHttp10 } = require('../bc-data-http10');

async function server(t, reply) {
  const sockets = new Set();
  const listener = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let request = Buffer.alloc(0);
    socket.on('data', chunk => {
      request = Buffer.concat([request, chunk]);
      const split = request.indexOf('\r\n\r\n');
      if (split < 0) return;
      const size = Number(/Content-Length: ([0-9]+)/i.exec(request.subarray(0, split).toString())[1]);
      if (request.length < split + 4 + size) return;
      socket.removeAllListeners('data');
      reply(socket, request);
    });
  });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => listener.close(resolve));
  });
  return { url: `http://127.0.0.1:${listener.address().port}/BC/ODataV4/Test`, username: 'fixture', password: 'private-fixture', body: { inputJson: 'Živjo 世界' } };
}

test('uses actual HTTP/1.0 and preserves a large poorly compressible response without a helper process', async t => {
  const body = Buffer.from(JSON.stringify({ data: require('node:crypto').randomBytes(140000).toString('base64'), unicode: '世界😀' }));
  const options = await server(t, (socket, request) => {
    assert.match(request.toString('utf8'), /^POST \/BC\/ODataV4\/Test HTTP\/1\.0\r\n/);
    assert.match(request.toString(), /Accept-Encoding: identity\r\n/);
    assert.doesNotMatch(request.toString(), /Accept-Language:/i);
    assert.match(request.toString('utf8'), /Živjo 世界/);
    socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n');
    for (let offset = 0; offset < body.length; offset += 7119) socket.write(body.subarray(offset, offset + 7119));
    socket.end();
  });
  const result = await requestHttp10(options);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, body);
});

test('retains HTTP 200 and partial byte count when the response is truncated', async t => {
  const options = await server(t, socket => socket.end('HTTP/1.0 200 OK\r\nContent-Length: 100\r\n\r\npartial'));
  await assert.rejects(requestHttp10(options), error => error.code === 'incomplete_response' && error.status === 200 && error.receivedBytes === 7 && error.outcome === 'unknown');
});

test('optional request language uses the same bounded HTTP/1.0 transport', async t => {
  const options = await server(t, (socket, request) => {
    assert.match(request.toString(), /\r\nAccept-Language: de-DE\r\n/);
    assert.match(request.toString(), /^POST .* HTTP\/1\.0\r\n/);
    socket.end('HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\n{}');
  });
  assert.equal((await requestHttp10({ ...options, acceptLanguage: 'de-DE' })).status, 200);
});

test('invalid language headers cannot inject headers or start a request', async t => {
  let calls = 0;
  const options = await server(t, () => { calls++; });
  for (const acceptLanguage of ['de-DE\r\nX-Injected: yes', '', '*', 'de-DE,en-US', 'a'.repeat(36), 1031, null]) {
    assert.throws(() => requestHttp10({ ...options, acceptLanguage }), /Invalid BC Data HTTP configuration/);
  }
  assert.equal(calls, 0);
});

test('deadline cancels a partially delivered HTTP 200 without calling it successful', async t => {
  const options = await server(t, socket => socket.write('HTTP/1.0 200 OK\r\n\r\npartial'));
  await assert.rejects(requestHttp10({ ...options, timeoutMs: 50 }), error => error.code === 'timeout' && error.status === 200 && error.receivedBytes === 7);
});

for (const [header, code] of [
  ['Transfer-Encoding: chunked', 'unsupported_framing'],
  ['Content-Encoding: gzip', 'unsupported_framing'],
  ['Content-Length: 999999999', 'response_too_large'],
  ['Content-Length: 1\r\nContent-Length: 1', 'duplicate_headers']
]) test(`rejects unsafe/unqualified response framing: ${header}`, async t => {
  const options = await server(t, socket => socket.end(`HTTP/1.0 200 OK\r\n${header}\r\n\r\nx`));
  await assert.rejects(requestHttp10(options), error => error.code === code && !error.message.includes('private-fixture'));
});

test('aborted calls send no requests and do not retry', async t => {
  let calls = 0;
  const options = await server(t, () => { calls++; });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(requestHttp10({ ...options, signal: controller.signal }), { code: 'cancelled' });
  assert.equal(calls, 0);
});
