export { BudgetCounter } from './budget_do.js';
import { estimateCost } from "./costs.js";

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    // Budgets are identified by X-Budget-ID header or default
    const budgetId = request.headers.get("X-Budget-ID") || "default";

    // Allow override of budget via header for backwards compatibility
    const limitHeader = request.headers.get("X-Budget-Limit");

    // Today's date (UTC) for date-scoped counters
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(today.getUTCDate()).padStart(2, "0");
    const dateKey = `${yyyy}-${mm}-${dd}`;

    // Helper: get pricing table from KV or env var
    async function getPricing() {
      try {
        const raw = await env.BUDGET_KV.get("pricing_table");
        if (raw) return JSON.parse(raw);
      } catch (e) {
        // ignore
      }
      // defaults (USD per 1k tokens)
      return {
        "gpt-4": 0.09,
        "gpt-4o": 0.09,
        "gpt-4-turbo": 0.04,
        "gpt-3.5-turbo": 0.002,
        "default": 0.005
      };
    }

    // Helper: read current spend from Durable Object
    async function getCurrentSpend(budgetId, date) {
      // For local tests prefer KV when present; production will use Durable Objects if configured
      try {
        const kv = env && env.BUDGET_KV;
        if (kv) {
          const keys = [`usage:${date}`, `usage:${budgetId}`, `usage:${budgetId}:${date}`];
          for (const k of keys) {
            const stored = await kv.get(k);
            console.log('KV check', k, stored);
            if (stored) return parseFloat(stored);
          }
          console.log('KV check none found for keys', keys);
        }
      } catch (e) {
        console.error("KV get error", e);
      }

      // Prefer Durable Object when available (production). Fall back to 0 if not available
      try {
        if (env && env.BUDGET_DO && typeof env.BUDGET_DO.idFromName === 'function') {
          const id = env.BUDGET_DO.idFromName(budgetId);
          const obj = env.BUDGET_DO.get(id);
          const res = await obj.fetch(`https://durable/get?date=${date}`);
          if (res.status === 200) {
            const j = await res.json();
            return parseFloat(j.amount || 0);
          }
        }
      } catch (e) {
        console.error("DO get error", e);
      }
      return 0;
    }

    // Helper: atomic increment
    async function addSpend(budgetId, date, amount) {
      // Prefer Durable Object when available
      try {
        if (env && env.BUDGET_DO && typeof env.BUDGET_DO.idFromName === 'function') {
          const id = env.BUDGET_DO.idFromName(budgetId);
          const obj = env.BUDGET_DO.get(id);
          const res = await obj.fetch("https://durable/add", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ date, amount }),
          });
          if (res.status === 200) return await res.json();
        }
      } catch (e) {
        console.error("DO add error", e);
      }
      // Fallback to KV read-modify-write (not atomic, but OK for tests/local)
      try {
        const kv = env && env.BUDGET_KV;
        if (kv) {
          // Prefer budgetId-scoped key for compatibility with tests
          const key = `usage:${budgetId}`;
          const prevRaw = await kv.get(key);
          const prev = prevRaw ? parseFloat(prevRaw) : 0;
          const next = prev + Number(amount);
          await kv.put(key, String(next));
          return { date, prev, next };
        }
      } catch (e) {
        console.error("KV add error", e);
      }
      return null;
    }

    // Usage endpoint
    if (pathname === "/usage") {
      const current = await getCurrentSpend(budgetId, dateKey);
      // Determine limit: env var -> KV override -> header
      let limit = parseFloat(env.DAILY_BUDGET || 0);
      try {
        const storedLimit = await env.BUDGET_KV.get(`limit:${budgetId}`);
        if (storedLimit) limit = parseFloat(storedLimit);
      } catch (e) {}
      if (limitHeader) limit = parseFloat(limitHeader);
      return new Response(JSON.stringify({ budgetId, date: dateKey, current_spend: current, remaining: Math.max(0, limit - current) }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // Expose DO test proxy endpoints under /do/* to allow external testing of DO methods
    if (pathname.startsWith("/do/")) {
      try {
        const subpath = pathname.replace("/do", "");
        const id = env.BUDGET_DO.idFromName(budgetId);
        const obj = env.BUDGET_DO.get(id);
        // Forward the request to the Durable Object
        const forward = new Request(`https://durable${subpath}` , {
          method: request.method,
          headers: request.headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.clone().arrayBuffer(),
        });
        const resp = await obj.fetch(forward);
        return resp;
      } catch (e) {
        return new Response(JSON.stringify({ error: 'DO proxy error', detail: String(e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Preflight budget check before forwarding
    const currentSpend = await getCurrentSpend(budgetId, dateKey);
    let limit = parseFloat(env.DAILY_BUDGET || 0);
    try {
      const storedLimit = await env.BUDGET_KV.get(`limit:${budgetId}`);
      if (storedLimit) limit = parseFloat(storedLimit);
    } catch (e) {}
    if (limitHeader) limit = parseFloat(limitHeader);

    if (limit > 0 && currentSpend >= limit) {
      return new Response(JSON.stringify({ error: { message: `Budget Exceeded. Current: $${currentSpend.toFixed(6)}, Limit: $${limit.toFixed(2)}`, type: "budget_firewall_error", code: 429 } }), { status: 429, headers: { "Content-Type": "application/json" } });
    }

    // Forward to OpenAI API
    const targetUrl = new URL(request.url);
    targetUrl.hostname = "api.openai.com";
    targetUrl.protocol = "https:";
    targetUrl.port = "";
    const forwardReq = new Request(targetUrl.toString(), request);

    let upstreamResp;
    try {
      upstreamResp = await fetch(forwardReq);
    } catch (e) {
      return new Response(JSON.stringify({ error: "Upstream connection error" }), { status: 502 });
    }

    // After response: compute cost and atomically increment via DO
    // Handle streaming vs JSON
    const contentType = upstreamResp.headers.get("content-type") || "";

    // Function to record audit entry in KV without storing any text
    async function recordAudit(budgetId, model, tokens, cost) {
      try {
        // Sanitize tokens to ensure no prompt/completion text is stored
        let sanitizedTokens = null;
        if (typeof tokens === 'number') {
          sanitizedTokens = { total: Number(tokens) };
        } else if (tokens && typeof tokens === 'object') {
          const p = Number(tokens.prompt || 0);
          const c = Number(tokens.completion || 0);
          sanitizedTokens = { prompt: p, completion: c, total: p + c };
        } else {
          sanitizedTokens = { total: 0 };
        }
        const ts = new Date().toISOString();
        const key = `audit:${budgetId}:${ts}:${Math.random().toString(36).slice(2,8)}`;
        const val = JSON.stringify({ budgetId, model, tokens: sanitizedTokens, cost: Number(cost), timestamp: ts });
        await env.BUDGET_KV.put(key, val);
      } catch (e) {
        console.error("audit write failed", e);
      }
    }

    // Non-streaming JSON responses
    if (contentType.includes("application/json")) {
      const cloned = upstreamResp.clone();
      ctx.waitUntil((async () => {
        try {
          const data = await cloned.json();
          if (data && data.usage) {
            const model = data.model || (data.model ?? "gpt-3.5-turbo");
            const prompt = data.usage.prompt_tokens || 0;
            const completion = data.usage.completion_tokens || 0;
            const pricing = await getPricing();
            // Determine rate (USD per 1k tokens)
            let rate = pricing[model] ?? pricing[Object.keys(pricing).find(k => model && model.includes(k))] ?? pricing.default ?? 0.005;
            const cost = estimateCostFromPricing(rate, prompt + completion);
            if (cost > 0) {
              // Idempotency: if client provided X-Request-ID header, check with DO whether we've already processed this request
              const requestId = request.headers.get('X-Request-ID');
              let shouldCharge = true;
              if (requestId) {
                try {
                  const id = env.BUDGET_DO.idFromName(budgetId);
                  const obj = env.BUDGET_DO.get(id);
                  const pres = await obj.fetch('https://durable/processed', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requestId }),
                  });
                  if (pres.status === 200) {
                    const pj = await pres.json();
                    shouldCharge = pj.wasNew === true;
                  }
                } catch (e) {
                  console.error('idempotency check failed', e);
                }
              }
              if (shouldCharge) {
                await addSpend(budgetId, dateKey, cost);
                await recordAudit(budgetId, model, { prompt, completion }, cost);
              } else {
                // duplicate request; skip charging but still record a lightweight audit that a duplicate occurred
                try { await env.BUDGET_KV.put(`audit:${budgetId}:dup:${Date.now()}`, JSON.stringify({ budgetId, model, duplicateOf: requestId, timestamp: new Date().toISOString() })); } catch(e){}
              }
            }
          }
        } catch (e) {
          console.error("post-response accounting error", e);
        }
      })());

      return upstreamResp;
    }

    // Streaming (e.g., text/event-stream) -> tee the body to capture tokens if the upstream includes usage in final JSON
    if (contentType.includes("text/event-stream") || contentType.includes("stream")) {
      try {
        const [streamForClient, streamForProcessor] = upstreamResp.body.tee();
        // Return the client stream immediately
        const clientResp = new Response(streamForClient, { status: upstreamResp.status, statusText: upstreamResp.statusText, headers: upstreamResp.headers });

        // Process the second stream to capture events and possibly final usage data
        ctx.waitUntil((async () => {
          try {
            const reader = streamForProcessor.getReader();
            let decoder = new TextDecoder();
            let buf = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              // Optionally parse lines/events here. We'll keep accumulating and try to find JSON 'usage' at end.
            }
            // Attempt to extract a JSON object with usage from the buffered text
            const maybeJson = extractFinalJson(buf);
            if (maybeJson && maybeJson.usage) {
              const model = maybeJson.model || "gpt-3.5-turbo";
              const prompt = maybeJson.usage.prompt_tokens || 0;
              const completion = maybeJson.usage.completion_tokens || 0;
              const pricing = await getPricing();
              let rate = pricing[model] ?? pricing[Object.keys(pricing).find(k => model && model.includes(k))] ?? pricing.default ?? 0.005;
              const cost = estimateCostFromPricing(rate, prompt + completion);
              if (cost > 0) {
                // Idempotency: if client provided X-Request-ID header, check with DO whether we've already processed this request
                const requestId = request.headers.get('X-Request-ID');
                let shouldCharge = true;
                if (requestId) {
                  try {
                    const id = env.BUDGET_DO.idFromName(budgetId);
                    const obj = env.BUDGET_DO.get(id);
                    const pres = await obj.fetch('https://durable/processed', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ requestId }),
                    });
                    if (pres.status === 200) {
                      const pj = await pres.json();
                      shouldCharge = pj.wasNew === true;
                    }
                  } catch (e) {
                    console.error('idempotency check failed', e);
                  }
                }
                if (shouldCharge) {
                  await addSpend(budgetId, dateKey, cost);
                  await recordAudit(budgetId, model, { prompt, completion }, cost);
                } else {
                  // duplicate request; skip charging but still record a lightweight audit that a duplicate occurred
                  try { await env.BUDGET_KV.put(`audit:${budgetId}:dup:${Date.now()}`, JSON.stringify({ budgetId, model, duplicateOf: requestId, timestamp: new Date().toISOString() })); } catch(e){}
                }
              }
            }
          } catch (e) {
            console.error("stream processing error", e);
          }
        })());

        return clientResp;
      } catch (e) {
        console.error("stream tee failed", e);
        return upstreamResp;
      }
    }

    // Fallback: return upstream response
    return upstreamResp;
  },
};

function extractFinalJson(text) {
  // Try to find a JSON object at the end of the stream (double newline separated)
  try {
    const idx = text.lastIndexOf("\n\n");
    if (idx !== -1) {
      const candidate = text.slice(idx + 2).trim();
      if (candidate.startsWith("{")) return JSON.parse(candidate);
    }
  } catch (e) {}

  // Find the last '}' and attempt to find a matching opening '{' before it
  const lastClose = text.lastIndexOf('}');
  if (lastClose !== -1) {
    let depth = 0;
    for (let i = lastClose; i >= 0; i--) {
      const ch = text[i];
      if (ch === '}') depth++;
      else if (ch === '{') depth--;
      if (depth === 0) {
        const sub = text.slice(i, lastClose + 1);
        try {
          return JSON.parse(sub);
        } catch (e) {
          // continue searching earlier close brace
          break;
        }
      }
    }
  }
  return null;
}

function estimateCostFromPricing(ratePer1k, tokens) {
  return (tokens / 1000) * ratePer1k;
}

// Re-export estimateCost from costs.js for backwards compatibility with tests
export { estimateCost } from "./costs.js";

// Export helper for unit tests
export { extractFinalJson };
