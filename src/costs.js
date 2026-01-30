export function estimateCost(model, promptTokens, completionTokens) {
  let promptRate = 0; // per 1k tokens
  let completionRate = 0; // per 1k tokens

  if (model && (model.includes("gpt-4-turbo") || model.includes("gpt-4o"))) {
    promptRate = 0.01; 
    completionRate = 0.03;
  } else if (model && model.includes("gpt-4")) {
    promptRate = 0.03;
    completionRate = 0.06;
  } else if (model && model.includes("gpt-3.5-turbo")) {
    promptRate = 0.0005;
    completionRate = 0.0015;
  } else {
    // Fallback generic rate
    promptRate = 0.001; 
    completionRate = 0.002;
  }

  return (promptTokens / 1000 * promptRate) + (completionTokens / 1000 * completionRate);
}
