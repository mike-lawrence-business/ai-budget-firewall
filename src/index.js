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
      try {
        const id = env.BUDGET_DO.idFromName(budgetId);
        const obj = env.BUDGET_DO.get(id);
        const res = await obj.fetch(`https://durable/get?date=${date}`);
        if (res.status === 200) {
          const j = await res.json();
          return parseFloat(j.amount || 0);
        }
      } catch (e) {
        console.error("DO get error", e);
      }
      return 0;
    }

    // Helper: atomic increment
    async function addSpend(budgetId, date, amount) {
      try {
        const id = env.BUDGET_DO.idFromName(budgetId);
        const obj = env.BUDGET_DO.get(id);
        const res = await obj.fetch("https://durable/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date, amount }),
        });
        if (res.status === 200) return await res.json();
      } catch (e) {
        console.error("DO add error", e);
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
        const ts = new Date().toISOString();
        const key = `audit:${budgetId}:${ts}:${Math.random().toString(36).slice(2,8)}`;
        const val = JSON.stringify({ budgetId, model, tokens, cost, timestamp: ts });
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
              await addSpend(budgetId, dateKey, cost);
              await recordAudit(budgetId, model, { prompt, completion }, cost);
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
                await addSpend(budgetId, dateKey, cost);
                await recordAudit(budgetId, model, { prompt, completion }, cost);
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
  // Try to find a JSON object at the end of the stream
  try {
    const idx = text.lastIndexOf("\n\n");
    const candidate = text.slice(idx + 2).trim();
    if (candidate.startsWith("{")) return JSON.parse(candidate);
  } catch (e) {}
  // Try to find last brace pair
  const lastOpen = text.lastIndexOf("{");
  const lastClose = text.lastIndexOf("}");
  if (lastOpen !== -1 && lastClose !== -1 && lastClose > lastOpen) {
    try {
      const sub = text.slice(lastOpen, lastClose + 1);
      return JSON.parse(sub);
    } catch (e) {}
  }
  return null;
}

function estimateCostFromPricing(ratePer1k, tokens) {
  return (tokens / 1000) * ratePer1k;
}
