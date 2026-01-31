import assert from 'assert';
// Use global fetch available in Node 18+
const fetchFn = global.fetch || (await import('node-fetch').then(m=>m.default));

// Simple test that simulates calling the DO processed endpoint twice
// This test assumes the DO is reachable at the local emulation URL used in other tests.

async function testProcessedEndpoint(baseUrl) {
  const requestId = `req-${Math.random().toString(36).slice(2,8)}`;
  const res1 = await fetch(`${baseUrl}/processed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId }) });
  const j1 = await res1.json();
  assert.strictEqual(j1.wasNew, true, 'First claim should be new');

  const res2 = await fetch(`${baseUrl}/processed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId }) });
  const j2 = await res2.json();
  assert.strictEqual(j2.wasNew, false, 'Second claim should be recognized as duplicate');

  console.log('test_idempotency: PASS');
}

if (require.main === module) {
  const baseUrl = process.argv[2] || 'http://127.0.0.1:8787';
  testProcessedEndpoint(baseUrl).catch(e => { console.error(e); process.exit(1); });
}
