# AIBudgetFirewall 🛡️💸

**Hard stop-loss for your OpenAI API keys.**
*Because a while-loop shouldn't cost you your rent.*

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Platform: Cloudflare Workers](https://img.shields.io/badge/Platform-Cloudflare%20Workers-orange.svg)
![Cost: Free Tier](https://img.shields.io/badge/Cost-Free%20Tier-green.svg)

---

## The Problem
OpenAI's "soft limits" just send you an email while your script keeps burning cash. If a key leaks or a loop goes infinite, you want the API to **reject requests immediately** once a budget is hit.

## The Solution
A lightweight proxy that sits between your code and OpenAI. It runs on **your own** Cloudflare account (Free Tier).
- ✅ **Hard Stop:** Returns `429 Too Many Requests` instantly when budget is exceeded.
- 🔒 **Private:** Your keys never leave your control. No SaaS middleman.
- ⚡ **Fast:** Runs on Cloudflare Workers edge network (<10ms latency).
- 💸 **Free:** Runs comfortably within the Cloudflare Workers free tier (100k reqs/day).

---

## 🚀 5-Minute Setup

### Prerequisites
1.  A Cloudflare account (Free).
2.  Node.js / npm installed.

### 1. Clone & Install
```bash
git clone https://github.com/agentforge/aibudgetfirewall.git
cd ai-budget-firewall
npm install
```

### 2. Configure Budget
Edit `wrangler.toml` to set your daily limit (in USD):

```toml
[vars]
# Your daily hard limit in USD
DAILY_BUDGET = "5.00"

# Optional: Default Organization ID (if not passed in headers)
# OPENAI_ORG_ID = "org-..."
```

*Note: You can also set `OPENAI_API_KEY` here, or pass it from your client as usual. The proxy forwards the Authorization header.*

### 3. Deploy
Authenticate with Cloudflare and deploy:

```bash
npx wrangler login
npx wrangler deploy
```

You'll get a URL like: `https://ai-budget-firewall.<your-subdomain>.workers.dev`

### 4. Use It
In your code, just swap the `base_url`.

**Python (openai-python):**
```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-...",  # Your actual OpenAI key
    base_url="https://ai-budget-firewall.<your-subdomain>.workers.dev/v1"
)

# This request counts towards your budget
chat_completion = client.chat.completions.create(
    messages=[{"role": "user", "content": "Hello world"}],
    model="gpt-3.5-turbo",
)
```

**Node.js (openai-node):**
```javascript
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: 'sk-...',
  baseURL: 'https://ai-budget-firewall.<your-subdomain>.workers.dev/v1',
});
```

---

## ⚙️ How It Works

1.  **Intercepts Request:** The worker receives your API call.
2.  **Checks Budget:** It checks a Cloudflare Durable Object counter for your budget id and today's date (UTC).
3.  **Adjudicates:**
    *   **Under Budget:** Forwards the request to OpenAI.
    *   **Over Budget:** Returns `429 Too Many Requests` immediately.
4.  **Updates Usage:** After the OpenAI response completes (stream or non-stream), it calculates the cost using a pricing table and atomically increments the per-day Durable Object counter.


### Key Implementation Details
- Durable Objects: per-budget-id Durable Object instances provide atomic increments for date-scoped keys (usage:YYYY-MM-DD:<budget-id>). This ensures no race conditions when multiple requests finish at the same time.
- Date-scoped keys mean counters effectively reset every midnight UTC because a new date key is used.
- Pricing table: configurable via the KV key `pricing_table` (JSON) or falls back to sensible defaults embedded in the worker.
- Audit log: minimal metadata (budget-id, model, tokens, cost, timestamp) is written to KV under `audit:<budgetId>:<timestamp>:<rand>`; NO prompt or completion text is ever stored.

---

## 🔧 Configuration
- DAILY_BUDGET: set in `wrangler.toml` as an environment variable or via `vars` (string). If not set, per-budget limits can be stored in KV under `limit:<budgetId>`.
- Pricing table (KV): store a JSON map in BUDGET_KV with key `pricing_table`, e.g.: `{"gpt-3.5-turbo":0.002, "gpt-4":0.09}` where values are USD per 1k tokens.
- Durable Object binding: the worker expects a Durable Object binding named `BUDGET_DO` of class `BudgetCounter`.


## /usage Endpoint
- GET /usage with header `X-Budget-ID` returns `{ budgetId, date, current_spend, remaining }`.
- Authentication: the endpoint requires the `X-Budget-ID` header; it does not expose prompt or completion content.

---

## Tests
Run the basic unit tests (estimator) locally:

```bash
npm test
```

There is also a smoke test script you can extend to exercise the Durable Object locally with `wrangler dev`.

---

## Privacy & Security
- We only persist token counts and cost metadata. Prompt and completion text are never stored.
- The proxy forwards the `Authorization` header (your OpenAI key) to OpenAI and does not persist it.

---

## License
MIT. Use it, fork it, stay solvent.
