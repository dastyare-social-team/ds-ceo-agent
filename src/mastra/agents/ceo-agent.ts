import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { createTavilySearchTool, createTavilyExtractTool } from '@mastra/tavily';
import { waitUntil } from '@vercel/functions';
import { env } from '../env.ts';
import { createGuardedActionHandler, createGuardedHandler } from '../guard.ts';
import { assistantModel, openRouterReasoningOptions } from '../model.ts';
import { publishingTools } from '../tools/publishing.ts';

/**
 * Web search is only wired up when a Tavily key is present, so the agent boots
 * (and stays useful) without one. The instructions below are built to match.
 */
const hasWebSearch = Boolean(env('TAVILY_API_KEY'));

const tools: ToolsInput = {
  ...(hasWebSearch
    ? { webSearch: createTavilySearchTool(), fetchPage: createTavilyExtractTool() }
    : {}),
  ...publishingTools,
};

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
- Never state platform engagement figures, algorithm behaviour, posting-frequency penalties or shadowban risk as fact. Those are exactly the numbers you do not have. If asked about them, say you have no measured data and offer to check the account's own analytics instead.
- Never name a platform as an option unless you have called list-social-accounts in this conversation and seen it connected. Recommending a platform the user has not connected wastes their time and invents a capability you were not given.
- You remember previous turns in this chat, so you do not need the user to repeat context.`;

/**
 * Publishing rules.
 *
 * These duplicate the confirm gate on purpose. The gate in code is what makes the
 * rule true; this is what makes the model *know* the rule, so it asks rather than
 * trying and being refused. Belt and braces, because the cost of the gate firing
 * mid-publish is a confusing turn and the cost of it not existing is a post to the
 * wrong audience.
 */
const PUBLISHING = `Publishing to social accounts:

- Nothing reaches a platform until the user has approved the exact caption and targets. Show the proposal, ask, wait.
- propose-content records the proposal and returns an id. confirm-draft records the user's yes. Only then publish-approved will act.
- Never call publish-approved with confirmedByUser true unless the user just said yes in this conversation.
- Before proposing, call list-social-accounts to learn what is connected, and prepare-media to see which platforms the asset fits. Never suggest a platform the user has not connected.
- Call recall-story before writing any caption. Draw the voice from those notes and say which note you used. Captions written from the model alone sound like a template.
- If a media upload warns that the URL is not publicly fetchable, do not publish against it.
- A video arrives with its transcript attached. Write the caption from that transcript — that is what the video says. Do not ask the user to describe a video you have already been given the words for.
- If a transcript is missing, you have a transcribe-video tool: call it with the video's public URL rather than telling the user you have no transcription capability. You do have one.
- If the tool reports a failure, relay the reason. Do not silently fall back to asking the user to describe the video.
- An image arrives with nothing but a file name. You cannot see it, so ask for one line describing it rather than inventing a caption.
- Do not invent hashtags. Use recall-story for the founder's own language, and say plainly when you have no sourced hashtags rather than producing a plausible-looking list.
- To see what is already out there, call list-published-posts. Never guess a post id.
- To take something down, use remove-post. Prefer action unpublish over delete: unpublish takes it off the platform and keeps the record, while delete breaks the public link permanently and cannot be undone.
- Deleting a post does not erase the copies platforms already hold — caches, screenshots, analytics and search indexes survive it. Say so rather than implying a delete makes something disappear completely.`;

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
  instructions: `${instructions}\n\n${TOOLING}\n\n${PUBLISHING}`,
  memory: new Memory({
    options: {
      lastMessages: 20,
      // Keep a hard token ceiling too — a single web search result can be huge.
      messageHistory: { maxTokens: 8_000, atMaxRemoveTokens: 2_000 },
    },
  }),
  tools,
  outputProcessors: [],
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
      /**
       * Inline button presses. Routed through the same allowlist as messages: a
       * card posted into a group stays visible there, so anyone who can see the
       * Approve button must not be able to publish with it.
       */
      onAction: createGuardedActionHandler(),
    },
    // Vercel freezes the function as soon as the webhook 200s. waitUntil keeps
    // the instance alive until the agent has posted its reply. It is a no-op
    // elsewhere, but we only pass it on Vercel so local `mastra dev` is clean.
    waitUntil: process.env.VERCEL ? waitUntil : undefined,
  },
});

export { hasWebSearch };
