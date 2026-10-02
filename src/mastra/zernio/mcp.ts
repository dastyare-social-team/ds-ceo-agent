import { getCredentialSecret } from '../db/client.ts';

/**
 * Minimal client for Zernio's hosted MCP server.
 *
 * Zernio serves MCP over Streamable HTTP at a single endpoint speaking JSON-RPC
 * 2.0, so a remote tool call is one POST. No SDK is used on purpose: the MCP
 * TypeScript SDK would add a client stack to a bundle already at 105MB against a
 * 250MB Vercel ceiling, for two request shapes.
 *
 * Two details of Streamable HTTP are easy to get wrong:
 *
 *   1. The reply is `text/event-stream`, not JSON. One `data:` line carries the
 *      JSON-RPC result, so it is parsed out of the SSE framing.
 *   2. The server may issue an `mcp-session-id` on first contact and expect it
 *      echoed. It is captured opportunistically rather than required.
 *
 * An autonomous agent authenticates with `Authorization: Bearer <api key>`, per
 * Zernio's docs — there is no browser available for an OAuth flow.
 */

const MCP_ENDPOINT = process.env.ZERNIO_MCP_URL ?? 'https://mcp.zernio.com/mcp';
/** Generous next to the sub-second calls this makes, but finite. */
const TIMEOUT_MS = 30_000;

/** Published posts and scheduled posts are created here, and nowhere else. */
type ZernioAccount = 'default';

export interface McpCallResult {
  /** Text content, which is where Zernio puts its human-readable reply. */
  text: string;
  /** True when the tool itself failed, as opposed to a protocol error. */
  isError: boolean;
  sessionId?: string;
}

async function rpc(
  tool: string,
  args: Record<string, unknown>,
  account: string,
): Promise<McpCallResult> {
  const apiKey = await getCredentialSecret('zernio', account);
  if (!apiKey) {
    return {
      text: `No Zernio API key is stored for "${account}". Add one first, then retry.`,
      isError: true,
    };
  }

  let response: Response;
  try {
    response = await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: tool, arguments: args },
        id: 1,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    throw new Error(`Could not reach Zernio: ${redact(String((cause as Error)?.message ?? cause))}`);
  }

  if (response.status === 401 || response.status === 403) {
    return {
      text: 'Zernio rejected the API key. It may be revoked or belong to another workspace — add a fresh one.',
      isError: true,
    };
  }
  if (!response.ok) {
    return {
      text: `Zernio returned HTTP ${response.status}: ${redact((await response.text()).slice(0, 300))}`,
      isError: true,
    };
  }

  const sessionId = response.headers.get('mcp-session-id') ?? undefined;
  const result = parseRpc(await response.text());
  if (result.error) {
    return { text: `Zernio error ${result.error.code}: ${redact(result.error.message)}`, isError: true, sessionId };
  }
  const text = (result.result?.content ?? [])
    .map((part) => part.text ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();
  return { text, isError: result.result?.isError === true, sessionId };
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: { content?: { type: string; text?: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

/**
 * Pulls the JSON-RPC result out of an SSE-framed body.
 *
 * The server sends `event: message\ndata: {...}`, so parsing the body as JSON
 * fails. A plain JSON body is also accepted, since the spec lets the server
 * choose either based on the Accept header.
 */
function parseRpc(body: string): JsonRpcResponse {
  const trimmed = body.trim();
  if (!trimmed) throw new Error('Zernio returned an empty response');

  if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) {
    return JSON.parse(trimmed) as JsonRpcResponse;
  }
  const payloads = trimmed
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (!payloads.length) throw new Error('Zernio sent an event stream with no data frames');
  return JSON.parse(payloads[payloads.length - 1]) as JsonRpcResponse;
}

/** Keeps a key or bearer token out of anything that reaches a chat. */
function redact(detail: string): string {
  return detail
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer ***')
    .replace(/\bzn_[A-Za-z0-9_-]+/g, 'zn_***');
}

// --- core tools, whose names and arguments are fixed in Zernio's docs --------

/** The answer to "where can I actually post?" — every connected account. */
export async function listConnectedAccounts(account: ZernioAccount = 'default'): Promise<string> {
  return (await rpc('accounts_list', {}, account)).text;
}

export interface PublishInput {
  content: string;
  platform: string;
  /** Required by Zernio when a workspace has more than one account on a platform. */
  accountId?: string;
  mediaUrls?: string;
  /** Required for YouTube, recommended for Pinterest. */
  title?: string;
  /** Minutes from now. Ignored when publishNow is true. */
  scheduleMinutes?: number;
  publishNow?: boolean;
}

/**
 * Creates a real post at Zernio — published now, or scheduled.
 *
 * There is deliberately no "create draft here, publish it later" path. Zernio's
 * `posts_publish_now` is documented as `posts_create` with `publish_now: true`,
 * and the OpenAPI has no endpoint that promotes an existing draft, so a draft
 * created before approval could never be published by id. Approvals are therefore
 * held in this app's own `app_content_drafts` table and nothing reaches Zernio
 * until the user says yes — which also means no orphaned drafts accumulate in
 * the Zernio dashboard.
 */
export async function publishPost(
  input: PublishInput,
  account: ZernioAccount = 'default',
): Promise<{ text: string; isError: boolean }> {
  return rpc(
    'posts_create',
    {
      content: input.content,
      platform: input.platform,
      account_id: input.accountId ?? '',
      media_urls: input.mediaUrls ?? '',
      title: input.title ?? '',
      publish_now: input.publishNow === true,
      schedule_minutes: input.publishNow ? 0 : (input.scheduleMinutes ?? 60),
    },
    account,
  );
}

/** The same content to several platforms in one call. */
export async function crossPost(
  platforms: string[],
  input: { content: string; accountIds?: string[]; mediaUrls?: string },
  account: ZernioAccount = 'default',
): Promise<{ text: string; isError: boolean }> {
  return rpc(
    'posts_cross_post',
    {
      content: input.content,
      platforms: platforms.join(','),
      account_ids: (input.accountIds ?? []).join(','),
      media_urls: input.mediaUrls ?? '',
      publish_now: true,
    },
    account,
  );
}

// --- the long tail, resolved by search rather than by guessing ---------------

/**
 * Finds a tool by name fragment.
 *
 * Zernio generates one tool per OpenAPI operation and keeps them behind
 * `search_tools`/`call_tool`, so their exact names are not published and must not
 * be hardcoded — a guessed name fails at the worst moment, which is mid-publish.
 * `tools/list` needs no credential according to the docs but returns 401 without
 * one, so search is the only discovery route an API-key client has.
 */
export async function findTool(fragment: string, account: ZernioAccount = 'default'): Promise<string | undefined> {
  const result = await rpc('search_tools', { query: fragment }, account);
  if (result.isError) return undefined;
  // Replies name the tools it matched; take the first plausible one.
  const match = result.text.match(/\b([a-z0-9]+(?:_[a-z0-9]+){2,})\b/g);
  return match?.find((name) => name.includes(fragment.split(/\s+/)[0])) ?? match?.[0];
}

/** Invokes a tool discovered by findTool. */
export async function callDiscoveredTool(
  tool: string,
  args: Record<string, unknown>,
  account: ZernioAccount = 'default',
): Promise<{ text: string; isError: boolean }> {
  return rpc('call_tool', { name: tool, arguments: args }, account);
}

/**
 * Zernio HEAD-checks a media URL and reports per-platform size and duration
 * limits.
 *
 * Run before approval, because the failure it prevents is a post created
 * successfully and then rejected by one platform at publish time — after the
 * caption was approved, with the caption already public on the other platforms.
 */
export async function validateMediaUrl(
  url: string,
  account: ZernioAccount = 'default',
): Promise<{ text: string; isError: boolean; checked: boolean }> {
  const tool = await findTool('validate media', account);
  if (!tool) {
    // Not fatal: the limits are also enforced by Zernio at publish time. Saying so
    // is better than inventing a passing result.
    return {
      text: 'Could not locate Zernio media validation, so per-platform limits were not pre-checked.',
      isError: false,
      checked: false,
    };
  }
  const result = await callDiscoveredTool(tool, { url }, account);
  return { ...result, checked: true };
}