/**
 * Model selection for the CEO agent.
 *
 * Strategy: OpenRouter free models only, ordered by maximum context, with
 * automatic failover down the list. Mastra accepts an array of models and walks
 * it in order, moving to the next entry when the current one errors — so the
 * ordering *is* the priority.
 *
 * Every entry below was re-verified against the live OpenRouter API with this
 * project's key: a real chat-completions call with a tool definition attached,
 * checking both that it returns 200 and that it actually emits `tool_calls`.
 *
 *   model                                          context   verdict
 *   nvidia/nemotron-3-ultra-550b-a55b:free         1,000,000  200 + tools
 *   nvidia/nemotron-3.5-lightning:free             1,000,000  200 + tools
 *   stealth/space-bunny-alpha                      1,000,000  200 + tools
 *   dots-studio/dots-3-note-preview:free             512,000  200 + tools
 *   nvidia/nemotron-3-super-120b-a12b:free           262,144  200 + tools
 *   inclusionai/ling-3.0-flash-sante:free            262,144  200 + tools
 *   inclusionai/ling-3.0-flash-fin:free              262,144  200 + tools
 *   poolside/laguna-s-2.1:free                       262,144  200 + tools
 *   cohere/north-mini-code:free                      256,000  200 + tools
 *   liquid/lfm-2.5-2.6b:free                          65,536  200 + tools
 *   poolside/laguna-xs-2.1:free                      262,144  429 rate-limited
 *   qwen/qwen3.8-27b:free                            262,144  429 rate-limited
 *   google/gemma-4-31b-it:free                       262,144  429 rate-limited
 *   google/gemma-4-26b-a4b-it:free                   262,144  429 rate-limited
 *
 * The 429s are OpenRouter's own free-tier rate limits, not dead models — they
 * recover, so they stay in the chain as a deeper safety net rather than being
 * dropped. That is the whole point of the fallback list: free capacity is
 * unpredictable, and the chain absorbs it instead of the user seeing an error.
 *
 * Deliberately excluded:
 *   thinkingmachines/inkling:free, inkling-small:free  -> 403, agentic hosts only
 *   nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free -> 200 but no tool support
 *   google/lyria-3-*, nemotron-3.5-content-safety:free  -> not chat models
 *   openrouter/free                                     -> router pseudo-model
 *   paid slugs (e.g. deepseek/deepseek-v4-flash-0731)  -> this key has no credits
 */

export const FREE_MODEL_CHAIN: readonly { model: string; context: number }[] = [
  { model: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', context: 1_000_000 },
  { model: 'openrouter/nvidia/nemotron-3.5-lightning:free', context: 1_000_000 },
  { model: 'openrouter/stealth/space-bunny-alpha', context: 1_000_000 },
  { model: 'openrouter/dots-studio/dots-3-note-preview:free', context: 512_000 },
  { model: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free', context: 262_144 },
  { model: 'openrouter/inclusionai/ling-3.0-flash-sante:free', context: 262_144 },
  { model: 'openrouter/inclusionai/ling-3.0-flash-fin:free', context: 262_144 },
  { model: 'openrouter/poolside/laguna-s-2.1:free', context: 262_144 },
  { model: 'openrouter/cohere/north-mini-code:free', context: 256_000 },
  { model: 'openrouter/liquid/lfm-2.5-2.6b:free', context: 65_536 },
  // Rate-limited at verification time; kept as a deeper tier.
  { model: 'openrouter/poolside/laguna-xs-2.1:free', context: 262_144 },
  { model: 'openrouter/qwen/qwen3.8-27b:free', context: 262_144 },
  { model: 'openrouter/google/gemma-4-31b-it:free', context: 262_144 },
  { model: 'openrouter/google/gemma-4-26b-a4b-it:free', context: 262_144 },
];

const OPENCODE_PREFIX = 'opencode/';

/** OpenCode Zen gateway. Mastra appends `/chat/completions` to this base URL. */
const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1';

/**
 * OpenCode Zen free models that are reachable from outside OpenCode.
 *
 * Zen lists more free models, but each one rejects non-OpenCode clients with
 * `FreeTierError: "OpenCode's free tier can only be used from within OpenCode"`.
 * Only models that actually run are listed.
 */
const OPENCODE_FREE_MODELS: readonly string[] = ['space-bunny-free'];

export function opencodeModel(modelId: string) {
  return {
    id: `${OPENCODE_PREFIX}${modelId}` as `${string}/${string}`,
    url: OPENCODE_BASE_URL,
    apiKey: process.env.OPENCODE_API_KEY,
  };
}

/**
 * `opencode/<id>` becomes a Zen-backed model config; anything else is passed
 * through untouched for Mastra's provider router to resolve.
 */
export function resolveModel(spec: string): string | ReturnType<typeof opencodeModel> {
  if (!spec.startsWith(OPENCODE_PREFIX)) return spec;
  return opencodeModel(spec.slice(OPENCODE_PREFIX.length));
}

/**
 * Asks OpenRouter to return `reasoning_details`, which stream as `reasoning`
 * parts. The reasoning-block processor turns those into the collapsible section
 * on Telegram. Harmless on models that do not reason — they just return none.
 */
export function openRouterReasoningOptions() {
  return {
    providerOptions: {
      openrouter: { include_reasoning: true },
    },
  };
}

/**
 * The agent's model list: the free chain, plus OpenCode Zen as a cross-provider
 * safety net when `OPENCODE_FREE_MODELS=1`, so a broad OpenRouter outage still
 * produces an answer.
 *
 * `MODEL` pins a single model and disables the chain — useful for deliberately
 * A/B testing one model, and for reproducing a bad reply.
 */
export function assistantModelList() {
  const pinned = process.env.MODEL;
  if (pinned) {
    return [{ model: resolveModel(pinned), maxRetries: 0 }];
  }

  const list: { model: string | ReturnType<typeof opencodeModel>; maxRetries: number }[] =
    FREE_MODEL_CHAIN.map((entry) => ({
      model: entry.model,
      // Fail over immediately instead of retrying a model that is already failing.
      maxRetries: 0,
    }));

  if (process.env.OPENCODE_FREE_MODELS === '1') {
    for (const free of OPENCODE_FREE_MODELS) {
      list.push({ model: opencodeModel(free), maxRetries: 0 });
    }
  }

  return list;
}
