import assert from 'assert';

// Simple test that simulates calling the DO processed endpoint twice
// This test assumes the DO is reachable at the local emulation URL used in other tests.

async function testProcessedEndpoint(fetchFn, baseUrl) {
  const requestId = `req-${Math.random().toString(36).slice(2,8)}`;
  const res1 = await fetchFn(`${baseUrl}/processed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId }) });
  const j1 = await res1.json();
  assert.strictEqual(j1.wasNew, true, 'First claim should be new');

  const res2 = await fetchFn(`${baseUrl}/processed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId }) });
  const j2 = await res2.json();
  assert.strictEqual(j2.wasNew, false, 'Second claim should be recognized as duplicate');

  console.log('test_idempotency: PASS');
}

(async () => {
  const fetchFn = global.fetch || (await import('node-fetch').then(m=>m.default));
  const baseUrl = process.argv[2] || 'http://127.0.0.1:8787';
  try {
    await testProcessedEndpoint(fetchFn, baseUrl);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
