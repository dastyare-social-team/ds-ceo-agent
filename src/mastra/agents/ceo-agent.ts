import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { createTavilySearchTool, createTavilyExtractTool } from '@mastra/tavily';
import { waitUntil } from '@vercel/functions';
import { env } from '../env.ts';
import { createGuardedHandler } from '../guard.ts';
import { assistantModel, openRouterReasoningOptions } from '../model.ts';
import { StreamingThinkingProcessor } from '../processors/streaming-thinking.ts';

/**
 * Web search is only wired up when a Tavily key is present, so the agent boots
 * (and stays useful) without one. The instructions below are built to match.
 */
const hasWebSearch = Boolean(env('TAVILY_API_KEY'));

const tools: ToolsInput = hasWebSearch
  ? {
      webSearch: createTavilySearchTool(),
      fetchPage: createTavilyExtractTool(),
    }
  : {};

const TOOLING = hasWebSearch
  ? `You have two web tools:
- \`webSearch\` — run a search query. Use it for anything time-sensitive, factual, or outside your training data (news, prices, versions, docs, "who is", "how do I"). Pass \`timeRange\` for recency when the question implies it.
- \`fetchPage\` — pull the full text of 1-20 URLs. After searching, use this on the 1-2 best results when you need detail the snippet truncated (long articles, docs pages, changelogs).

Cite sources inline as markdown links so the user can verify. If a search returns nothing useful, say so rather than answering from memory as if it were current.`
  : `You do NOT currently have web search or page-fetching tools. If the user asks about something you cannot answer from the conversation or your own knowledge, say plainly that you cannot look it up right now. Do not guess at current facts, versions, prices, or news.`;

const instructions = `You are the Dastyare Social CEO agent, a private assistant reachable over Telegram.

Style:
- Lead with the answer. No preamble, no restating the question.
- Be concise. Telegram is a phone screen. A short correct answer beats a long hedged one.
- Use plain markdown. A few short paragraphs or a tight bullet list is usually right. Do not use headings for short replies, and never use a table unless the data is genuinely tabular.
- No emojis unless the user uses them first.
- Match the user's language. If they write in Persian, reply in Persian.

Behaviour:
- You are advising the operator of Dastyare Social. Default to a decisive, business-aware point of view, and give a clear recommendation rather than a survey of options.
- Use tools rather than recalling from memory when the question involves current or external information.
- When you are uncertain, say so. Never invent citations, URLs, or numbers.
- You remember previous turns in this chat, so you do not need the user to repeat context.`;

export const ceoAgent = new Agent({
  id: 'ceo-agent',
  name: 'Dastyare Social — CEO Agent',
  /**
   * An ordered array of models. Mastra walks it in order and moves to the next
   * entry when the current one errors, so this is the free-model fallback
   * chain: highest context first, down to smaller stand-ins, and on to OpenCode
   * Zen, then the OpenRouter free tier. A user never sees a model error.
   */
  model: assistantModel(),
  defaultOptions: openRouterReasoningOptions(),
  instructions: `${instructions}\n\n${TOOLING}`,
  memory: new Memory({
    options: {
      lastMessages: 20,
      // Keep a hard token ceiling too — a single web search result can be huge.
      messageHistory: { maxTokens: 8_000, atMaxRemoveTokens: 2_000 },
    },
  }),
  tools,
  outputProcessors: [new StreamingThinkingProcessor()],
  channels: {
    adapters: {
      telegram: createTelegramAdapter({
        /**
         * Defaults to 'webhook' deliberately, not 'auto'.
         *
         * In 'auto' the adapter falls back to long polling when it cannot see a
         * public base URL. On Vercel that failure mode is expensive: a polling
         * loop holds the serverless function open, burning invocations and
         * timing out. Webhook mode is the only correct mode for this deploy
         * target. Set TELEGRAM_MODE=polling if you want to test locally without
         * a tunnel.
         */
        mode: (env('TELEGRAM_MODE') as 'auto' | 'webhook' | 'polling' | undefined) ?? 'webhook',
      }),
    },
    /**
     * Allowlist enforcement. All three handlers need guarding, not just DMs:
     * `onSubscribedMessage` is the one people forget — once the agent has
     * subscribed to a thread, later messages route to the agent without going
     * through `onDirectMessage`, so guarding only DMs would leave group threads
     * open to anyone who finds the bot.
     */
    handlers: {
      onDirectMessage: createGuardedHandler('direct message'),
      onMention: createGuardedHandler('mention'),
      onSubscribedMessage: createGuardedHandler('subscribed-thread message', {
        notifySender: false,
      }),
    },
    // Vercel freezes the function as soon as the webhook 200s. waitUntil keeps
    // the instance alive until the agent has posted its reply. It is a no-op
    // elsewhere, but we only pass it on Vercel so local `mastra dev` is clean.
    waitUntil: process.env.VERCEL ? waitUntil : undefined,
  },
});

export { hasWebSearch };
