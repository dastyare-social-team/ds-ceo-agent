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
