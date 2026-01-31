
import worker, { estimateCost } from '../src/index.js';
import assert from 'assert';

console.log("Running Local Tests...");

// --- Mock Environment ---
const mockKV = {
  store: {},
  async get(key) { return this.store[key] || null; },
  async put(key, value) { this.store[key] = value; }
};

const mockEnv = {
  BUDGET_KV: mockKV
};

const mockCtx = {
  waitUntil: (promise) => { 
    // Just await it immediately for testing purposes
    promise.then(() => {}).catch(console.error); 
  }
};

// --- Test 1: Cost Estimation ---
console.log("Test 1: Cost Estimation Logic");
try {
  const costGpt4 = estimateCost("gpt-4-turbo", 1000, 1000);
  assert.strictEqual(costGpt4.toFixed(2), "0.04", "GPT-4 Turbo 1k/1k should be $0.04");
  
  const costGpt35 = estimateCost("gpt-3.5-turbo", 1000, 1000);
  assert.strictEqual(costGpt35.toFixed(4), "0.0020", "GPT-3.5 Turbo 1k/1k should be $0.0020");
  
  console.log("✅ Cost Estimation Passed");
} catch (e) {
  console.error("❌ Cost Estimation Failed:", e.message);
}

// --- Test 2: Blocking Logic (Over Limit) ---
console.log("\nTest 2: Blocking Logic (Over Limit)");
async function testBlockingLogic() {
  try {
    // Setup: Limit $5, Usage $6
    mockKV.store['limit:default'] = "5.00";
    mockKV.store['usage:default'] = "6.00";

    const req = new Request("https://worker.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer sk-test", "X-Budget-ID": "default" }
    });

    const res = await worker.fetch(req, mockEnv, mockCtx);
    
    assert.strictEqual(res.status, 429, "Should return 429 when over budget");
    const body = await res.json();
    assert.ok(body.error.message.includes("Budget Exceeded"), "Error message should mention budget");
    
    console.log("✅ Blocking Logic Passed");
  } catch (e) {
    console.error("❌ Blocking Logic Failed:", e);
  }
}

// --- Test 3: Allowed Logic (Under Limit) ---
console.log("\nTest 3: Allowed Logic (Under Limit)");
async function testAllowedLogic() {
  try {
    // Setup: Limit $5, Usage $1
    mockKV.store['limit:default'] = "5.00";
    mockKV.store['usage:default'] = "1.00";

    // Mock global fetch to intercept the forwarded request
    global.fetch = async (req) => {
        if (req.url.includes("api.openai.com")) {
            return new Response(JSON.stringify({
                model: "gpt-3.5-turbo",
                usage: { prompt_tokens: 1000, completion_tokens: 1000 }
            }), { 
                headers: { "content-type": "application/json" }
            });
        }
        return new Response("Not Found", { status: 404 });
    };

    const req = new Request("https://worker.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer sk-test", "X-Budget-ID": "default" }
    });

    const res = await worker.fetch(req, mockEnv, mockCtx);
    
    assert.strictEqual(res.status, 200, "Should return 200 when under budget");
    
    // Wait a bit for waitUntil to process (KV update)
    await new Promise(r => setTimeout(r, 100));
    
    // Check if usage updated
    // Previous: 1.00
    // Cost: 0.0020 (from Test 1 calculation for 3.5-turbo)
    // New: 1.002
    const newUsage = parseFloat(mockKV.store['usage:default']);
    assert.ok(newUsage > 1.00, "Usage should increment");
    assert.strictEqual(newUsage.toFixed(4), "1.0020", "Usage calculation should be correct");

    console.log("✅ Allowed Logic & Usage Update Passed");
  } catch (e) {
    console.error("❌ Allowed Logic Failed:", e);
  }
}

// Run tests sequentially
(async () => {
  await testBlockingLogic();
  await testAllowedLogic();
})();
