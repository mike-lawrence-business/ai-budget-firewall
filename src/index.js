
export default {
  async fetch(request, env, ctx) {
    // 1. Handle OPTIONS (CORS)
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
    
    // 2. Configuration & Key Extraction
    const authHeader = request.headers.get("Authorization");
    // We use the Authorization header (API Key) as the identifier for the budget bucket 
    // strictly for lookup, but we won't log it.
    // Alternatively, user can provide a custom header 'X-Budget-ID' to group multiple keys.
    const budgetId = request.headers.get("X-Budget-ID") || "default"; 
    const limitHeader = request.headers.get("X-Budget-Limit"); // Allow setting limit via header for MVP convenience
    
    // 3. Check KV for current usage
    // KV Namespace: BUDGET_KV
    // Key: usage:<budgetId>
    // Key: limit:<budgetId>
    
    let currentUsage = 0;
    let limit = 5.00; // Default $5.00
    
    try {
      const storedUsage = await env.BUDGET_KV.get(`usage:${budgetId}`);
      if (storedUsage) currentUsage = parseFloat(storedUsage);
      
      const storedLimit = await env.BUDGET_KV.get(`limit:${budgetId}`);
      if (storedLimit) limit = parseFloat(storedLimit);
      
      // Override limit if header provided (and update KV for persistence)
      if (limitHeader) {
        limit = parseFloat(limitHeader);
        ctx.waitUntil(env.BUDGET_KV.put(`limit:${budgetId}`, limit.toString()));
      }
    } catch (e) {
      // If KV fails, we default to allow but log error? 
      // Or fail safe? Let's fail safe (block) or proceed? 
      // MVP: Proceed with 0 usage assumption if KV is down, but likely KV is stable.
      console.error("KV Error", e);
    }

    // 4. Check Limit
    if (currentUsage >= limit) {
      return new Response(JSON.stringify({
        error: {
          message: `Budget Exceeded. Current: $${currentUsage.toFixed(4)}, Limit: $${limit.toFixed(2)}`,
          type: "budget_firewall_error",
          code: 429
        }
      }), { status: 429, headers: { "Content-Type": "application/json" } });
    }

    // 5. Forward Request
    // We need to construct a new request to OpenAI
    // Target: https://api.openai.com/v1/...
    const targetUrl = new URL(request.url);
    targetUrl.hostname = "api.openai.com";
    targetUrl.protocol = "https:";
    targetUrl.port = "";
    
    const newRequest = new Request(targetUrl, request);
    // Ensure host header is correct or removed (fetch handles it)
    
    let response;
    try {
      response = await fetch(newRequest);
    } catch (e) {
      return new Response(JSON.stringify({ error: "Upstream connection error" }), { status: 502 });
    }

    // 6. Calculate Cost (Post-Response)
    // Clone response to read body without consuming the original stream for the client
    const responseClone = response.clone();
    
    ctx.waitUntil((async () => {
      try {
        // Only parse JSON responses for usage data
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
          const data = await responseClone.json();
          if (data.usage) {
            // Calculate cost based on model
            const model = data.model || "gpt-3.5-turbo"; // fallback
            const promptTokens = data.usage.prompt_tokens || 0;
            const completionTokens = data.usage.completion_tokens || 0;
            
            const cost = estimateCost(model, promptTokens, completionTokens);
            
            if (cost > 0) {
              const newUsage = currentUsage + cost;
              await env.BUDGET_KV.put(`usage:${budgetId}`, newUsage.toString());
              console.log(`[Budget] ID: ${budgetId} | Cost: $${cost.toFixed(6)} | New Total: $${newUsage.toFixed(6)}`);
            }
          }
        }
      } catch (err) {
        console.error("Error updating usage:", err);
      }
    })());

    return response;
  },
};

// Simple cost estimator (Rates as of Late 2023/Early 2024 - simplified)
export function estimateCost(model, promptTokens, completionTokens) {
  let promptRate = 0; // per 1k tokens
  let completionRate = 0; // per 1k tokens

  if (model.includes("gpt-4-turbo") || model.includes("gpt-4o")) {
    promptRate = 0.01; 
    completionRate = 0.03;
  } else if (model.includes("gpt-4")) {
    promptRate = 0.03;
    completionRate = 0.06;
  } else if (model.includes("gpt-3.5-turbo")) {
    promptRate = 0.0005;
    completionRate = 0.0015;
  } else {
    // Fallback generic rate
    promptRate = 0.001; 
    completionRate = 0.002;
  }

  return (promptTokens / 1000 * promptRate) + (completionTokens / 1000 * completionRate);
}
