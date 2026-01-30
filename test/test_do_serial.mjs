import assert from 'assert';
import { BudgetCounter } from '../src/budget_do.js';

function makeStorage() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : undefined; },
    async put(key, value) { store.set(key, value); }
  };
}

function makeState() {
  return {
    storage: makeStorage()
  };
}

async function runSequentialAdds(iterations, amountPerReq) {
  const state = makeState();
  const env = {};
  const actor = new BudgetCounter(state, env);

  const date = '2026-01-30';
  for (let i = 0; i < iterations; i++) {
    const req = new Request(`https://durable/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, amount: amountPerReq })
    });
    await actor.fetch(req);
  }

  const getReq = new Request(`https://durable/get?date=${date}`, { method: 'GET' });
  const res = await actor.fetch(getReq);
  const j = await res.json();
  const expected = iterations * amountPerReq;
  return { actual: j.amount, expected };
}

(async () => {
  console.log('Running sequential DO increment test (simulating CF DO serialization)...');
  const iterations = 100;
  const amount = 0.01;
  const { actual, expected } = await runSequentialAdds(iterations, amount);
  console.log('Expected:', expected, 'Actual:', actual);
  assert.strictEqual(parseFloat(actual), expected, 'Final amount should equal sum of increments');
  console.log('✅ Sequential DO increment test passed');
})();
