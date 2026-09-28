import { Mastra } from '@mastra/core';
import { VercelDeployer } from '@mastra/deployer-vercel';
import { RedisStreamsPubSub } from '@mastra/redis-streams';
import { ceoAgent } from './agents/ceo-agent.ts';
import { storage } from './db.ts';
import { env } from './env.ts';

const AGENT_ID = 'ceo-agent';

const redisUrl = env('REDIS_URL');

// Vercel routes each request to a different instance, so without shared
// pub/sub two instances can both pick up the same Telegram update and reply
// twice. Redis fixes that; it is optional locally.
if (process.env.VERCEL && !redisUrl) {
  console.warn(
    '[mastra] REDIS_URL is not set. Concurrent messages in the same chat may ' +
      'be handled twice on Vercel. Add a Redis instance (Vercel Marketplace or ' +
      'Upstash) to fix this.',
  );
}

export const mastra = new Mastra({
  agents: { [AGENT_ID]: ceoAgent },
  storage,
  ...(redisUrl
    ? {
        pubsub: new RedisStreamsPubSub({
          url: redisUrl,
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
