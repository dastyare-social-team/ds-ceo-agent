/** The subset of a channel SentMessage the progress indicator relies on. */
export interface SentMessageLike {
  edit?: (message: string) => Promise<unknown>;
  delete?: () => Promise<void>;
}
