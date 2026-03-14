import { logVerbose } from "../../globals.js";
import type { ReplyPayload } from "../types.js";
import type { BlockStreamingCoalescing } from "./block-streaming.js";

export type BlockReplyCoalescer = {
  enqueue: (payload: ReplyPayload) => void;
  flush: (options?: { force?: boolean }) => Promise<void>;
  hasBuffered: () => boolean;
  stop: () => void;
};

export function createBlockReplyCoalescer(params: {
  config: BlockStreamingCoalescing;
  shouldAbort: () => boolean;
  onFlush: (payload: ReplyPayload) => Promise<void> | void;
}): BlockReplyCoalescer {
  const { config, shouldAbort } = params;
  // Wrap onFlush to catch errors from fire-and-forget calls
  const safeOnFlush = (payload: ReplyPayload) => {
    try {
      const result = params.onFlush(payload);
      if (result && typeof result === "object" && "catch" in result) {
        result.catch((err: unknown) => {
          logVerbose(`block-reply-coalescer: flush delivery failed: ${String(err)}`);
        });
      }
    } catch (err) {
      logVerbose(`block-reply-coalescer: flush delivery failed: ${String(err)}`);
    }
  };
  const minChars = Math.max(1, Math.floor(config.minChars));
  const maxChars = Math.max(minChars, Math.floor(config.maxChars));
  const idleMs = Math.max(0, Math.floor(config.idleMs));
  const joiner = config.joiner ?? "";
  const flushOnEnqueue = config.flushOnEnqueue === true;

  let bufferText = "";
  let bufferReplyToId: ReplyPayload["replyToId"];
  let bufferAudioAsVoice: ReplyPayload["audioAsVoice"];
  let idleTimer: NodeJS.Timeout | undefined;

  const clearIdleTimer = () => {
    if (!idleTimer) {
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const resetBuffer = () => {
    bufferText = "";
    bufferReplyToId = undefined;
    bufferAudioAsVoice = undefined;
  };

  const scheduleIdleFlush = () => {
    if (idleMs <= 0) {
      return;
    }
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      flush({ force: false }).catch((err) => {
        logVerbose(`block-reply-coalescer: idle flush failed: ${String(err)}`);
      });
    }, idleMs);
  };

  const flush = async (options?: { force?: boolean }) => {
    clearIdleTimer();
    if (shouldAbort()) {
      resetBuffer();
      return;
    }
    if (!bufferText) {
      return;
    }
    if (!options?.force && !flushOnEnqueue && bufferText.length < minChars) {
      scheduleIdleFlush();
      return;
    }
    const payload: ReplyPayload = {
      text: bufferText,
      replyToId: bufferReplyToId,
      audioAsVoice: bufferAudioAsVoice,
    };
    resetBuffer();
    await params.onFlush(payload);
  };

  const enqueue = (payload: ReplyPayload) => {
    if (shouldAbort()) {
      return;
    }
    const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
    const text = payload.text ?? "";
    const hasText = text.trim().length > 0;
    if (hasMedia) {
      flush({ force: true }).catch((err) => {
        logVerbose(`block-reply-coalescer: forced flush failed: ${String(err)}`);
      });
      safeOnFlush(payload);
      return;
    }
    if (!hasText) {
      return;
    }

    // When flushOnEnqueue is set (chunkMode="newline"), each enqueued payload is treated
    // as a separate paragraph and flushed immediately so delivery matches streaming boundaries.
    if (flushOnEnqueue) {
      if (bufferText) {
        flush({ force: true }).catch((err) => {
          logVerbose(`block-reply-coalescer: forced flush failed: ${String(err)}`);
        });
      }
      bufferReplyToId = payload.replyToId;
      bufferAudioAsVoice = payload.audioAsVoice;
      bufferText = text;
      flush({ force: true }).catch((err) => {
        logVerbose(`block-reply-coalescer: forced flush failed: ${String(err)}`);
      });
      return;
    }

    const replyToConflict = Boolean(
      bufferText &&
      payload.replyToId &&
      (!bufferReplyToId || bufferReplyToId !== payload.replyToId),
    );
    if (bufferText && (replyToConflict || bufferAudioAsVoice !== payload.audioAsVoice)) {
      flush({ force: true }).catch((err) => {
        logVerbose(`block-reply-coalescer: forced flush failed: ${String(err)}`);
      });
    }

    if (!bufferText) {
      bufferReplyToId = payload.replyToId;
      bufferAudioAsVoice = payload.audioAsVoice;
    }

    const nextText = bufferText ? `${bufferText}${joiner}${text}` : text;
    if (nextText.length > maxChars) {
      if (bufferText) {
        flush({ force: true }).catch((err) => {
          logVerbose(`block-reply-coalescer: forced flush failed: ${String(err)}`);
        });
        bufferReplyToId = payload.replyToId;
        bufferAudioAsVoice = payload.audioAsVoice;
        if (text.length >= maxChars) {
          safeOnFlush(payload);
          return;
        }
        bufferText = text;
        scheduleIdleFlush();
        return;
      }
      safeOnFlush(payload);
      return;
    }

    bufferText = nextText;
    if (bufferText.length >= maxChars) {
      flush({ force: true }).catch((err) => {
        logVerbose(`block-reply-coalescer: forced flush failed: ${String(err)}`);
      });
      return;
    }
    scheduleIdleFlush();
  };

  return {
    enqueue,
    flush,
    hasBuffered: () => Boolean(bufferText),
    stop: () => clearIdleTimer(),
  };
}
