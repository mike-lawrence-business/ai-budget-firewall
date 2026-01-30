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
2.  **Checks KV:** It checks Cloudflare KV for your current daily spend.
3.  **Adjudicates:**
    *   **Under Budget:** Forwards the request to OpenAI.
    *   **Over Budget:** Returns `429 Too Many Requests` immediately.
4.  **Updates Usage:** After the OpenAI response comes back, it calculates the cost (based on tokens) and increments your spend in KV.

*Privacy Note: The worker does NOT log your prompt text or completion text. It only inspects the `usage` field in the response JSON to count tokens.*

---

## 🛠️ Advanced Configuration

### Custom Limits per Key/User
You can pass a custom header `X-Budget-ID` to track separate budgets for different apps or users.

```python
client = OpenAI(
    base_url="...",
    default_headers={"X-Budget-ID": "project-alpha"}
)
```

### Resetting Usage
Usage keys expire automatically every 24 hours (TTL). To manually reset:
```bash
npx wrangler kv:key delete usage:default --binding=BUDGET_KV
```

---

## License
MIT. Use it, fork it, stay solvent.
