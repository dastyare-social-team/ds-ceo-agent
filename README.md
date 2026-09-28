# Dastyare Social — CEO Agent

A private AI assistant on Telegram, built with [Mastra](https://mastra.ai) and deployed as
a Vercel serverless function. Conversation memory lives in Postgres (Neon). Only two
named Telegram accounts can talk to it.

- **Agent:** `ceo-agent` — *Dastyare Social — CEO Agent*
- **Model:** free only. OpenCode Zen first, then OpenRouter free models as fallback
- **Web search:** Tavily, optional
- **Memory:** per-chat, capped at 20 messages / 8k tokens, stored in Postgres
- **Access:** allowlisted Telegram user IDs only
- **Webhook:** `/api/agents/ceo-agent/channels/telegram/webhook`

## Layout

```
src/mastra/
  index.ts              # Mastra instance: storage, deployer, pubsub
  env.ts                # env reader that treats blank values as unset
  access.ts             # the allowlist
  guard.ts              # wraps channel handlers with allowlist enforcement
  db.ts                 # PostgresStore + connection-string hardening
  agents/ceo-agent.ts   # the agent, its tools, and the Telegram channel adapter
scripts/set-webhook.mjs # registers the webhook with Telegram
test/access.test.ts     # access-control tests (npm test)
```

## Access control

Only the Telegram user IDs in `TELEGRAM_ALLOWED_USER_IDS` (default
`2063150861,8440954997`) can use the bot. Everyone else is rejected in
`src/mastra/guard.ts` **before** the agent runs, so a blocked message never reaches
the model, the tools, or storage.

All three channel handlers are guarded — `onDirectMessage`, `onMention`, and
`onSubscribedMessage`. The last one matters most: once the agent subscribes to a
thread, later messages bypass the DM handler, so guarding only DMs would quietly
leave group chats open.

In groups, a stranger is blocked **silently** — replying "access denied" in a shared
chat broadcasts to everyone and confirms the bot exists. Every block is logged as
`[access] Blocked …`, which is the only way to tell "rejected" apart from "broken".

```bash
npm test    # 4 tests covering allowed, stranger, near-miss, empty and undefined ids
```

## Local development

```bash
npm install
cp .env.example .env    # then fill it in
npm run dev             # http://localhost:4111
```

The adapter defaults to `TELEGRAM_MODE=webhook`, which on localhost has no public
URL to receive updates. For local work without a tunnel, set
`TELEGRAM_MODE=polling` and the bot will long-poll instead. With a tunnel:

```bash
npx cloudflared tunnel --url http://localhost:4111
node scripts/set-webhook.mjs https://<tunnel-url>
```

Remember to point the webhook back at your production URL when you're done.

## Deploying to Vercel

**1. Database.** Set `DATABASE_URL` to your Postgres connection string. A free
[Turso](https://turso.new) or Neon database is plenty. **Do not** use a `file:` URL —
Vercel's filesystem is ephemeral, so all memory would be lost on every cold start.

**2. Redis (recommended).** Vercel routes each request to a different instance, so
without shared pub/sub two instances can both pick up the same Telegram update and
reply twice. Add Redis from the Vercel Marketplace (or Upstash) and set `REDIS_URL`.
The app logs a warning at boot if you deploy without it.

**3. Push and connect.** Import the repo in Vercel and set:

| Variable | Required | Notes |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | yes | <https://openrouter.ai/keys> |
| `TELEGRAM_BOT_TOKEN` | yes | from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | yes | **must match** the value given to `set-webhook` |
| `DATABASE_URL` | yes | Postgres, remote, `sslmode=verify-full` |
| `TELEGRAM_ALLOWED_USER_IDS` | no | defaults to `2063150861,8440954997` |
| `REDIS_URL` | optional | connection string for shared pub/sub |
| `REDIS_PUBSUB` | optional | keep `0` — enabling it deadlocks streaming, see below |
| `TAVILY_API_KEY` | optional | <https://app.tavily.com>; enables web search |
| `OPENCODE_API_KEY` | yes | Zen is the primary tier; remove it to run OpenRouter-only |
| `MODEL` | optional | pins one model and disables the free chain — see Model routing |
| `TELEGRAM_MODE` | optional | keep `webhook` on Vercel — see below |
| `MASTRA_STUDIO` | optional | leave off in production — see Security |

Vercel runs `npm run build`, which invokes `mastra build`. That emits
`.vercel/output` in Build Output API v3 format, which Vercel picks up automatically.
No `vercel.json` needed.

**4. Register the webhook** once the first deploy is live:

```bash
node scripts/set-webhook.mjs https://your-app.vercel.app
# or, if PUBLIC_URL is set in .env:
npm run webhook
```

Then message your bot from an allowlisted account.

**5. Verify.** `https://your-app.vercel.app/api/agents` lists the agent.
`npm run webhook:remove` detaches the bot.

## Database and TLS notes

`src/mastra/db.ts` adjusts your connection string before handing it to node-postgres,
because two things in a stock Neon URL are misleading:

- **`sslmode=require` → `verify-full`.** `pg-connection-string` v2 treats `require` as
  an alias for `verify-full`, so the certificate *is* verified today. In v3 (pg v9) it
  adopts libpq semantics, where `require` stops verifying anything. Pinning
  `verify-full` keeps the connection verified across that upgrade. The app logs when
  it rewrites.
- **`channel_binding=require` is stripped.** Neon appends it, but node-postgres has
  no implementation and silently drops it. Leaving it in the URL implies protection
  that is not actually being applied.

Mastra creates its own schema on first run (43 tables and ~100 indexes) and reuses it
afterwards. To manage it separately, call `await storage.init()` during a migration
step and pass `disableInit: true`.

## Model routing

Two **free** tiers, tried in this order:

1. **OpenCode Zen** — attempted first.
2. **OpenRouter free models** — the fallback tier.

Mastra accepts an array of models and walks it in order, failing over on error, so the
ordering *is* the priority and the user never sees a model error. The chain lives in
`src/mastra/model.ts`. Every entry sets `maxRetries: 0` — when a model is already failing,
retrying it just makes the user wait instead of moving on.

### Tier 1 — OpenCode Zen

Zen publishes 43 models, 10 named as free. All 10 were tested with a real
chat-completions call carrying a tool definition. **Nine are unusable from a server** —
they answer `403 OpenCode's free tier can only be used from within OpenCode`:

`nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `ling-3.0-flash-fin-free`,
`mimo-v2.6-flash-free`, `mimo-v2.5-free`, `jev-1.13-free`, `longcat-2.5-preview-free`,
`muse-spark-1.3-contributor-free`, `muse-spark-1.2-contributor-free`

That is a deliberate access control on the provider's side, and this agent runs on a Vercel
server rather than inside the OpenCode client. Exactly one Zen free model is reachable:

| Model | Verified |
| --- | --- |
| `opencode/space-bunny-free` | 200 + tools |

So "OpenCode first" resolves to a single model. If Zen ever widens server access, add the
new ids to `OPENCODE_MODELS` — the ordering and failover already work. Removing
`OPENCODE_API_KEY` gives a valid OpenRouter-only configuration.

Zen does not publish context lengths: its `/models` endpoint returns only `id`, `object`,
`created`, and `owned_by`, and they could not be verified without probing the limit with
oversized requests. No number is asserted rather than a guess going into a comment. It is
not the binding constraint anyway — the agent caps history at 8k tokens.

### Tier 2 — OpenRouter free

Free models only, ordered by max context, because the supplied OpenRouter key has no
credits and any paid slug would fail at call time.
The chain therefore contains only models that returned a real response — each was
verified with a live chat-completions call carrying a tool definition, checking both
that it returns 200 and that it actually emits `tool_calls`:

| Model | Context | Verified |
| --- | --- | --- |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1,000,000 | 200 + tools |
| `nvidia/nemotron-3.5-lightning:free` | 1,000,000 | 200 + tools |
| `stealth/space-bunny-alpha` | 1,000,000 | 200 + tools |
| `dots-studio/dots-3-note-preview:free` | 512,000 | 200 + tools |
| `nvidia/nemotron-3-super-120b-a12b:free` | 262,144 | 200 + tools |
| `inclusionai/ling-3.0-flash-sante:free` | 262,144 | 200 + tools |
| `inclusionai/ling-3.0-flash-fin:free` | 262,144 | 200 + tools |
| `poolside/laguna-s-2.1:free` | 262,144 | 200 + tools |
| `cohere/north-mini-code:free` | 256,000 | 200 + tools |
| `liquid/lfm-2.5-2.6b:free` | 65,536 | 200 + tools |
| `poolside/laguna-xs-2.1:free` | 262,144 | 429 rate-limited |
| `qwen/qwen3.8-27b:free` | 262,144 | 429 rate-limited |
| `google/gemma-4-31b-it:free` | 262,144 | 429 rate-limited |
| `google/gemma-4-26b-a4b-it:free` | 262,144 | 429 rate-limited |

The 429s are OpenRouter's own free-tier rate limits, not dead models. They are kept as a
deeper tier because they recover — the chain absorbs unpredictable free capacity instead
of the user seeing an error. Excluded permanently: `thinkingmachines/inkling*` (403,
agentic hosts only), `nemotron-3-nano-omni-…-reasoning` (200 but no tool support, so it
cannot run an agent), the `lyria` music models, `content-safety`, and the `openrouter/free`
router pseudo-model.

Every entry sets `maxRetries: 0` — when a model is already failing, retrying it wastes the
user's wait instead of moving on to the next free model.

Set `MODEL` to pin one model and disable the chain, for A/B testing or to reproduce a bad
reply. It accepts a Zen id or an OpenRouter id.

Re-verify the chain before trusting it, since free-tier availability changes:

```bash
npm test          # asserts the chain shape and ordering
```

## Reasoning

`src/mastra/processors/reasoning-block.ts` renders any model reasoning as a quoted
**Thinking** section above the answer. It fires only for models that actually return
reasoning; most free models here do not, so it is usually invisible.

It is a distinct quoted section, **not** a collapsible one. True collapsing is not
reachable through this adapter, verified against the adapter's own converter
(`test/reasoning.test.ts` locks both facts in):

- Telegram's expandable blockquote (`<blockquote expandable>`) requires
  `parse_mode: HTML`. The Telegram adapter ships no HTML support at all —
  `toBotApiParseMode` only ever returns `MarkdownV2`.
- A spoiler (`||like this||`) is the one collapsible feature MarkdownV2 has, but it is
  only produced by a `spoiler` AST node. Raw `||` in markdown text is escaped to `\|\|`
  and renders as literal characters. An output processor can only emit text, so it
  cannot construct that node.

## Security notes

- **Rotate your bot token.** `.env` is gitignored, but if the token was ever pasted
  into a chat, log, or commit, revoke it with @BotFather (`/revoke`) and put the new
  one in `.env` and on Vercel. Do the same for the Neon password in `DATABASE_URL` —
  it grants full access to the conversation database.
- **Always set `TELEGRAM_WEBHOOK_SECRET_TOKEN`.** Telegram echoes it in the
  `X-Telegram-Bot-Api-Secret-Token` header and the adapter rejects anything else with
  a 401, so someone who finds your webhook URL cannot drive the agent.
- **Keep `TELEGRAM_MODE=webhook` on Vercel.** In `auto` the adapter silently falls
  back to long polling when it cannot see a public base URL. A polling loop holds a
  serverless function open, burning invocations until it times out.
- **Leave `MASTRA_STUDIO` off in production.** Studio is served at the site root and
  grants unauthenticated full access to the agent, its tools, and its memory. Only
  enable it behind Vercel Authentication on a preview deployment.
- `mastra getAgentById(...)` and other REST endpoints are unauthenticated by default.
  If you add agent HTTP routes, put auth in front of them.

### What is and isn't encrypted

Worth being precise, since "encrypted conversations" can mean several things:

- **In transit:** yes. The Vercel → Neon connection uses TLS with
  `sslmode=verify-full`, and Postgres traffic is likewise encrypted.
- **At rest:** yes, by Neon. Its volumes are encrypted at the storage layer.
- **Message content:** **not** encrypted by this application. `mastra_messages.content`
  is stored as plaintext, readable by anyone with database access and visible in
  Studio. There is no field-level encryption, because encrypting message bodies would
  break semantic recall and any content filtering, which need to read the text.
- **Bot and webhook tokens:** plaintext inside your own `.env` and Vercel env vars.
  `MASTRA_ENCRYPTION_KEY` exists to encrypt stored bot tokens at rest, but only when
  using Mastra's higher-level `TelegramProvider`; this project wires the lower-level
  `createTelegramAdapter`, so it does not apply.

If you need message content unreadable to anyone holding a database dump, that is a
separate decision with real tradeoffs — say the word and I'll scope it properly rather
than bolt on something that quietly degrades memory search.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Bot replies `401 Invalid secret token` | `TELEGRAM_WEBHOOK_SECRET_TOKEN` differs between Vercel and the value given to `set-webhook`. |
| Bot ignores messages, and `getWebhookInfo` shows `pending_update_count` climbing | The webhook URL is not registered, so Telegram has nowhere to deliver. Run `npm run webhook -- https://your-app.vercel.app`. |
| Bot receives messages but never replies, and nothing lands in Postgres | Shared pub/sub is on. `RedisStreamsPubSub` deadlocks `agent.stream()` on `@mastra/core` 1.71.0, and the Telegram channel streams, so every run hangs after the webhook already returned 200 — Telegram sees success and never retries. Set `REDIS_PUBSUB=0`. |
| `getWebhookInfo` shows `Wrong response from the webhook: 503` and messages never arrive | A cold-started function served the webhook before the Chat SDK finished initialising. Mastra's route only guards when `initPromise` already exists, so the request was rejected and Telegram held the update. `src/mastra/index.ts` now initialises the channel at module load to close that window. If it persists, check the function's max duration — initialisation needs a few seconds on a cold start. |
| Bot replies `503 Service unavailable` | The adapter could not reach Telegram or its state store. Check deploy logs and confirm `DATABASE_URL` is remote. |
| Nobody gets a reply, no errors | A stranger was blocked. Look for `[access] Blocked` in the logs. |
| Bot forgets everything between messages | `DATABASE_URL` is a `file:` URL on Vercel. The app throws at boot in that case. |
| Every message gets two replies | `REDIS_URL` is not set. |
| Replies are the wrong model | Check `src/mastra/model.ts` for the chain, and `MODEL` if it is set — it pins a single model and disables failover. `openrouter/…` needs `OPENROUTER_API_KEY`. |
| Agent claims it cannot search | `TAVILY_API_KEY` is unset. Tools are only attached when it exists. |
| `Bad Request: chat not found` | The bot cannot open a conversation. Telegram only lets a bot message a user who has already started it, so an allowed user must send `/start` first. This is also why the model chain and reasoning block are verified locally rather than by sending a test message. |
| Every model in the chain 429s | OpenRouter free-tier rate limit, per account and per model. The chain fails over; if Zen and the whole OpenRouter pool are exhausted the request fails until capacity returns. |
| Database connection errors on deploy | Confirm the Neon host allows your Vercel region and that `sslmode=verify-full` passes; if Neon presents a chain `pg` rejects, fall back to `sslmode=require` (the app will rewrite it again, so check the log). |
| Nothing happens locally | Expected. `webhook` mode needs a public URL — use a tunnel, or set `TELEGRAM_MODE=polling`. |
