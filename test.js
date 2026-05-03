import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let server;
let port;
let dataDir;

function request(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers
    };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'offer-doctor-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.AI_PROVIDER = 'heuristic';
  
  const serverModule = await import('./server.js');
  server = serverModule.server;
  
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
});

after(async () => {
  server.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('Path traversal is blocked', async () => {
  for (const method of ['GET', 'PATCH', 'DELETE']) {
    const body = method === 'PATCH' ? JSON.stringify({ favorite: true }) : null;
    const res = await request(method, '/api/reports/..%2F..%2Fpackage', {}, body);
    assert.strictEqual(res.status, 400);
    assert.ok(!res.body.includes('offer-doctor'), `Leaked package.json content 'offer-doctor' via ${method}`);
    assert.ok(!res.body.includes('dependencies'), `Leaked package.json content 'dependencies' via ${method}`);
    assert.ok(!res.body.includes('scripts'), `Leaked package.json content 'scripts' via ${method}`);
  }
});

test('Invalid JSON returns 400', async () => {
  const res = await request('POST', '/api/analyze', {}, '{ bad json');
  assert.strictEqual(res.status, 400);
});

test('Oversized JSON returns 413', async () => {
  const largeData = 'a'.repeat(301 * 1024);
  const payload = JSON.stringify({ niche: largeData });
  const res = await request('POST', '/api/analyze', {}, payload);
  assert.strictEqual(res.status, 413);
});

test('SSRF blocks internal URLs', async () => {
  const urls = [
    `http://127.0.0.1:${port}/`,
    `http://[::1]:${port}/`,
    `http://[::ffff:127.0.0.1]:${port}/`,
    `http://[::ffff:7f00:1]:${port}/`,
    `http://169.254.169.254/`
  ];
  for (const url of urls) {
    const res = await request('POST', '/api/analyze', {}, JSON.stringify({ url }));
    assert.strictEqual(res.status, 403, `Failed on ${url} with status ${res.status}`);
  }
});

test('Public URL happy path', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (url.toString() === 'https://example.com/') {
      return {
        status: 200,
        ok: true,
        headers: {
          get: (name) => name.toLowerCase() === 'content-type' ? 'text/html' : null
        },
        body: (async function* () {
          yield Buffer.from('<html><head><title>Mock Title</title></head><body><p>This is a sufficiently long paragraph to pass the extraction logic length check in the application.</p></body></html>');
        })()
      };
    }
    return originalFetch(url, options);
  };

  try {
    const res = await request('POST', '/api/analyze', {}, JSON.stringify({ url: 'https://example.com/' }));
    assert.strictEqual(res.status, 200);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Admin token behavior', async () => {
  // Unset token
  delete process.env.ADMIN_TOKEN;
  let res = await request('GET', '/api/reports?limit=2');
  assert.strictEqual(res.status, 200);

  // Set token
  process.env.ADMIN_TOKEN = 'test-token';
  
  // Without auth
  res = await request('GET', '/api/reports?limit=2');
  assert.strictEqual(res.status, 401);
  
  // With auth
  res = await request('GET', '/api/reports?limit=2', { 'Authorization': 'Bearer test-token' });
  assert.strictEqual(res.status, 200);
});

test('Lead source URL sanitization', async () => {
  process.env.ADMIN_TOKEN = 'test-token';

  // Create a saved report with a malicious extraction URL
  const reportsDir = path.join(dataDir, 'reports');
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.writeFile(path.join(reportsDir, '999-badurl.json'), JSON.stringify({
    id: "999-badurl",
    createdAt: new Date().toISOString(),
    report: {
      total: 50,
      diagnosis: "bad",
      meta: {
        extraction: {
          url: "javascript:alert(1)",
          finalUrl: "javascript:alert(1)"
        }
      }
    }
  }));

  const payload = JSON.stringify({
    name: "Test Lead",
    email: "test@example.com",
    report: {
      reportId: "999-badurl"
    }
  });
  
  const resPost = await request('POST', '/api/leads', {}, payload);
  assert.strictEqual(resPost.status, 200);

  const resGet = await request('GET', '/api/leads?limit=10', { 'Authorization': 'Bearer test-token' });
  assert.strictEqual(resGet.status, 200);
  
  const leads = JSON.parse(resGet.body).leads;
  const lead = leads.find(l => l.email === "test@example.com");
  assert.ok(lead);
  assert.strictEqual(lead.sourceUrl, "");
});

test('History ordering and malformed JSON', async () => {
  const reportsDir = path.join(dataDir, 'reports');
  await fs.mkdir(reportsDir, { recursive: true });

  // Add a malformed JSON file
  await fs.writeFile(path.join(reportsDir, 'bad.json'), '{ bad json }');

  // Add older un-favorited report
  await fs.writeFile(path.join(reportsDir, '100-aaaaaa.json'), JSON.stringify({
    id: "100-aaaaaa",
    createdAt: "2020-01-01T00:00:00Z",
    favorite: false
  }));

  // Add newer un-favorited report
  await fs.writeFile(path.join(reportsDir, '200-bbbbbb.json'), JSON.stringify({
    id: "200-bbbbbb",
    createdAt: "2021-01-01T00:00:00Z",
    favorite: false
  }));

  // Add older favorited report
  await fs.writeFile(path.join(reportsDir, '300-cccccc.json'), JSON.stringify({
    id: "300-cccccc",
    createdAt: "2019-01-01T00:00:00Z",
    favorite: true
  }));

  process.env.ADMIN_TOKEN = 'test-token';
  const res = await request('GET', '/api/reports?limit=10', { 'Authorization': 'Bearer test-token' });
  assert.strictEqual(res.status, 200);

  const reports = JSON.parse(res.body).reports;
  const testIds = ["100-aaaaaa", "200-bbbbbb", "300-cccccc"];
  const ourReports = reports.filter(r => testIds.includes(r.id));
  
  assert.strictEqual(ourReports.length, 3);
  assert.strictEqual(ourReports[0].id, "300-cccccc"); // Favorite first
  assert.strictEqual(ourReports[1].id, "200-bbbbbb"); // Newer non-favorite next
  assert.strictEqual(ourReports[2].id, "100-aaaaaa"); // Older non-favorite last
});
