/**
 * Model selection for the CEO agent.
 *
 * Priority: OpenCode Zen first, then OpenRouter free models as the fallback
 * tier. Mastra accepts an array of models and walks it in order, moving to the
 * next entry when the current one errors, so the ordering *is* the priority.
 * Every entry sets `maxRetries: 0` — when a model is already failing, retrying
 * it just makes the user wait instead of failing over.
 *
 * ── OpenCode Zen (primary) ────────────────────────────────────────────────────
 *
 * Zen publishes 43 models, 10 of them named as free. All 10 were tested with a
 * real chat-completions call carrying a tool definition. Nine are unusable from
 * a server:
 *
 *   nemotron-3-ultra-free            403  "OpenCode's free tier can only be
 *   nemotron-3.5-lightning-free            used from within OpenCode"
 *   ling-3.0-flash-fin-free
 *   mimo-v2.6-flash-free
 *   mimo-v2.5-free
 *   jev-1.13-free
 *   longcat-2.5-preview-free
 *   muse-spark-1.3-contributor-free
 *   muse-spark-1.2-contributor-free
 *
 * That check is a deliberate access control on the provider's side, and this
 * agent runs on a Vercel server rather than inside the OpenCode client. Only one
 * Zen free model is reachable:
 *
 *   space-bunny-free   200 + tools
 *
 * So "OpenCode first" resolves to exactly one model. If OpenCode Zen ever widens
 * server access, add the new ids to OPENCODE_MODELS — the ordering and the
 * failover already work, nothing else needs to change.
 *
 * Zen does not publish context lengths (its /models endpoint returns only id,
 * object, created and owned_by), and they could not be verified without probing
 * the limit with oversized requests. No number is asserted here rather than a
 * guess going into a comment. It is not the binding constraint in practice: the
 * agent caps conversation history at 8k tokens, two orders of magnitude below
 * any plausible window.
 *
 * ── OpenRouter (fallback tier) ───────────────────────────────────────────────
 *
 * Free models only, ordered by max context, because the supplied OpenRouter key
 * has no credits and any paid slug would fail on every call. Each entry was
 * verified with a live tool-enabled call, checking both that it returns 200 and
 * that it actually emits `tool_calls`:
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
 * The 429s are OpenRouter's own free-tier rate limits, not dead models. They
 * recover, so they stay as a deeper tier rather than being dropped: free
 * capacity is unpredictable, and absorbing that is the whole point of the chain.
 *
 * Deliberately excluded:
 *   thinkingmachines/inkling:free, inkling-small:free  -> 403, agentic hosts only
 *   nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free -> 200 but no tool support
 *   google/lyria-3-*, nemotron-3.5-content-safety:free  -> not chat models
 *   openrouter/free                                     -> router pseudo-model
 *   paid slugs (e.g. deepseek/deepseek-v4-flash-0731)  -> key has no credits
 */

/** Zen base URL. Mastra appends `/chat/completions`. */
const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1';

const OPENCODE_PREFIX = 'opencode/';

/**
 * OpenCode Zen models, tried in order ahead of every OpenRouter model.
 * Only ids verified to answer a server-side tool-enabled call belong here.
 */
const OPENCODE_MODELS: readonly string[] = ['space-bunny-free'];

/** OpenRouter free tier, ordered by max context. */
export const OPENROUTER_FREE_CHAIN: readonly { model: string; context: number }[] = [
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

/** Back-compat alias for the OpenRouter tier. */
export const FREE_MODEL_CHAIN = OPENROUTER_FREE_CHAIN;

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

type ChainEntry = { model: string | ReturnType<typeof opencodeModel>; maxRetries: number };

/**
 * The agent's model list: OpenCode Zen first, then the OpenRouter free tier.
 *
 * OpenCode is included only when `OPENCODE_API_KEY` is set — without a key the
 * Zen calls cannot authenticate, and listing them anyway would burn a failover
 * slot on a guaranteed 401. Remove the key to fall back to OpenRouter-only, or
 * set `MODEL` to pin a single model and disable the chain entirely.
 */
/**
 * The agent's model: a single model, not Mastra's model array.
 *
 * Priority is still OpenCode Zen first, then OpenRouter free models, but the
 * array form currently deadlocks the streaming path. Reproduced on
 * @mastra/core 1.71.0, the latest release:
 *
 *   - `agent.stream(...)` with a model ARRAY never resolves. Not slow, not
 *     retrying: `await a.stream()` itself hangs indefinitely before a single
 *     chunk, with any entry in the array, with or without output processors, and
 *     with both a Zen and a native OpenRouter entry.
 *   - `agent.stream(...)` with a single model STRING resolves in ~7s and
 *     streams normally.
 *   - `agent.generate(...)` works with BOTH shapes. Only streaming breaks.
 *
 * The Telegram channel streams, so the array form made every inbound message
 * hang — and because the handler had already returned 200, Telegram saw a
 * successful delivery, never retried, and the bot just never replied. That is
 * why the failure looked like "no response" rather than an error.
 *
 * So the default is one model. `OPENCODE_FALLBACK_CHAIN=1` re-enables the array
 * (the correct shape for `generate`) and is documented as unsafe for the
 * Telegram channel until the deadlock is fixed upstream.
 */
export function assistantModel(): string | ReturnType<typeof opencodeModel> {
  const pinned = process.env.MODEL;
  if (pinned) return resolveModel(pinned);
  return opencodeModel(OPENCODE_MODELS[0]);
}

/**
 * The full ordered chain: OpenCode Zen first, then the OpenRouter free tier.
 * Safe for `generate`; NOT safe for streaming on @mastra/core 1.71.0.
 *
 * Zen is included only when `OPENCODE_API_KEY` is set — without a key the calls
 * cannot authenticate, so listing them would waste a failover slot on a
 * guaranteed 401. Removing the key yields a valid OpenRouter-only chain.
 */
export function assistantModelChain(): ChainEntry[] {
  const pinned = process.env.MODEL;
  if (pinned) return [{ model: resolveModel(pinned), maxRetries: 0 }];

  const list: ChainEntry[] = [];
  if (process.env.OPENCODE_API_KEY) {
    for (const id of OPENCODE_MODELS) list.push({ model: opencodeModel(id), maxRetries: 0 });
  }
  for (const entry of OPENROUTER_FREE_CHAIN) list.push({ model: entry.model, maxRetries: 0 });
  return list;
}

/** Single model by default; the array only when explicitly opted back in. */
export function assistantModelList(): ChainEntry[] {
  if (process.env.OPENCODE_FALLBACK_CHAIN === '1') return assistantModelChain();
  return [{ model: assistantModel(), maxRetries: 0 }];
}

/**
 * Asks OpenRouter to return `reasoning_details`, which stream as `reasoning`
 * parts. The streaming-thinking processor shows them live, then removes them, so the
 * Telegram. Harmless on models that do not reason — they just return none.
 */
export function openRouterReasoningOptions() {
  return {
    providerOptions: {
      openrouter: { include_reasoning: true },
    },
  };
}
