/**
 * Minimal declarations for the two archive-extraction helpers, which ship no
 * types of their own. Only the surface `src/mastra/voice.ts` actually uses is
 * declared, so this stays honest about what the project depends on.
 */
declare module 'unbzip2-stream' {
  import type { Transform } from 'node:stream';
  export function createBzip2(): Transform;
}

declare module 'tar-stream' {
  import type { Readable, Writable } from 'node:stream';

  export interface Extract extends Writable {
    on(
      event: 'entry',
      listener: (
        header: { name: string; type?: string },
        stream: Readable,
        next: (err?: Error | null) => void,
      ) => void,
    ): Extract;
  }

  export function extract(): Extract;
}
