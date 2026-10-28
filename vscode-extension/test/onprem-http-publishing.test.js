const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { authorizeRoot, resolveWithinRoot } = require('../path-security');

for (const storedCredential of [false, true]) {
  test(`Windows HTTP publishing sends multipart data with ${storedCredential ? 'stored' : 'default'} credentials`, { timeout: 20000 }, async (t) => {
    const temporaryRoot = authorizeRoot(os.tmpdir(), 'Test temporary root');
    const fixtureRoot = fs.mkdtempSync(resolveWithinRoot(temporaryRoot, 'bc-onprem-http-'));
    const fixtureFile = resolveWithinRoot(fixtureRoot, 'fixture.app');
    fs.writeFileSync(fixtureFile, 'multipart regression fixture');
    const requests = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        requests.push({ url: request.url, method: request.method, headers: request.headers, body });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{}');
      });
    });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.unlinkSync(fixtureFile);
      fs.rmdirSync(fixtureRoot);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      resolveWithinRoot(__dirname, 'onprem-http-publishing.tests.ps1'),
      '-Port', String(server.address().port), '-FixtureRoot', fixtureRoot];
    if (storedCredential) args.push('-StoredCredential');
    const result = await new Promise((resolve, reject) => {
      const child = spawn('pwsh', args, { windowsHide: true, timeout: 15000 });
      let output = '';
      t.after(() => { if (child.exitCode === null) child.kill(); });
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Successfully published 'fixture\.app' to 'loopback'\./);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/BC230/dev/apps?SchemaUpdateMode=synchronize&DependencyPublishingOption=ignore');
    assert.match(requests[0].headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.match(requests[0].body, /filename="?fixture\.app"?/);
    assert.match(requests[0].body, /multipart regression fixture/);
  });
}
