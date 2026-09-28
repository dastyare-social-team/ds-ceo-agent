import { Mastra } from '@mastra/core';
import { VercelDeployer } from '@mastra/deployer-vercel';
import { RedisStreamsPubSub } from '@mastra/redis-streams';
import { ceoAgent } from './agents/ceo-agent.ts';
import { warmVoiceModel } from './voice.ts';
import { storage } from './db.ts';
import { env } from './env.ts';

const AGENT_ID = 'ceo-agent';

const redisUrl = env('REDIS_URL');

/**
 * Shared pub/sub, OFF by default.
 *
 * It exists so two Vercel instances cannot both handle the same Telegram update
 * and reply twice. But on @mastra/core 1.71.0 (the latest release) enabling it
 * deadlocks the streaming path, and the Telegram channel streams:
 *
 *   - Mastra with `pubsub: new RedisStreamsPubSub(...)`  -> agent.stream() never
 *     resolves, before any chunk.
 *   - Mastra without pubsub                              -> agent.stream()
 *     resolves in ~14s and streams normally.
 *
 * `agent.generate()` is unaffected, which is why this hid for so long: it was
 * the one path that still worked. With pubsub on, the webhook returned 200
 * immediately, the run then hung, Telegram saw a successful delivery, never
 * retried, and the bot simply never replied.
 *
 * A live bot that answers once is worth more than one that risks a duplicate
 * reply, so this is opt-in via REDIS_PUBSUB=1. Remove the risk of duplicates by
 * other means — for example a single Vercel instance, or a queue — and re-enable
 * it once the deadlock is fixed upstream.
 */
const pubsubEnabled = process.env.REDIS_PUBSUB === '1' && Boolean(redisUrl);

if (process.env.VERCEL && redisUrl && !pubsubEnabled) {
  console.warn(
    '[mastra] REDIS_URL is set but REDIS_PUBSUB is not, so shared pub/sub is OFF. ' +
      'Concurrent messages in the same chat may be handled twice on Vercel. ' +
      'Enabling it deadlocks streaming on @mastra/core 1.71.0 — see src/mastra/index.ts.',
  );
}

export const mastra = new Mastra({
  agents: { [AGENT_ID]: ceoAgent },
  storage,
  ...(pubsubEnabled
    ? {
        pubsub: new RedisStreamsPubSub({
          url: redisUrl as string,
          keyPrefix: 'mastra:ds-ceo-agent',
        }),
      }
    : {}),
  deployer: new VercelDeployer({
    // Studio is served at the site root and gives full access to every agent,
    // so it stays off unless you explicitly ask for it.
    studio: env('MASTRA_STUDIO') === 'true',
  }),
});

/** Path Mastra registers for the Telegram webhook. */
export const TELEGRAM_WEBHOOK_PATH = `/api/agents/${AGENT_ID}/channels/telegram/webhook`;

/**
 * Close the cold-start window on the Telegram webhook.
 *
 * Mastra's webhook route checks readiness like this:
 *
 *   if (self.initPromise) await self.initPromise;
 *   if (!self.chat) return 503 "Chat not initialized";
 *
 * The first line only guards when `initPromise` exists, and `initPromise` is
 * only created inside `AgentChannels.initialize()` — which Mastra calls
 * "after the server is ready". On Vercel a freshly-warmed function can serve the
 * webhook before that has run, so `initPromise` is still null, the guard is
 * skipped, and the request is rejected. Telegram then reports
 * "Wrong response from the webhook: 503" and holds the update instead of
 * delivering it, so messages silently never arrive.
 *
 * Initialising here, at module load, means the module is not importable-and-ready
 * until `chat` exists. A request cannot reach the handler before that.
 *
 * Failures are logged rather than thrown: leaving them uncaught would make the
 * whole function fail to load, and a retried initialize() is better than a dead
 * endpoint.
 */
const channels = mastra.getChannels()[ceoAgent.id];
if (channels) {
  try {
    await channels.initialize(mastra);
  } catch (error) {
    console.error(
      '[mastra] Telegram channel failed to initialise; the webhook will return 503 ' +
        'until a later request retries it.',
      error,
    );
  }
}

// Download the local Whisper weights alongside the channel so the first voice note
// is answered promptly rather than waiting on a model fetch. Failures are logged and
// retried on demand: a cold Hugging Face must not stop the bot answering text.
await warmVoiceModel();
