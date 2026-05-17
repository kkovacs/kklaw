// telegram.ts — Telegram-specific utilities: API interfaces, safe editor for
// streaming edits with MESSAGE_TOO_LONG / parse-error handling, HTML escaping,
// and tool-call formatting.

import { escapeText } from "./relay";

export interface TelegramApi {
  sendMessage(chatId: number | string, text: string, other?: Record<string, unknown>): Promise<{ message_id: number }>;
  editMessageText(chatId: number | string, messageId: number, text: string, other?: Record<string, unknown>): Promise<unknown>;
  sendChatAction?(chatId: number | string, action: string): Promise<unknown>;
  getFile?(fileId: string): Promise<{ file_path?: string }>;
  deleteMessage?(chatId: number | string, messageId: number): Promise<unknown>;
}

export async function downloadTelegramFile(
  api: TelegramApi,
  botToken: string,
  fileId: string,
): Promise<Buffer> {
  const file = await api.getFile?.(fileId);
  if (!file?.file_path) throw new Error("Telegram getFile: no file_path");
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export interface MessageContext {
  chatId: number | string;
  from?: { id: number };
  msg: { text?: string };
  reply(text: string, other?: Record<string, unknown>): Promise<unknown>;
  react(emoji: string): Promise<unknown>;
}

export interface PhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface PhotoMessageContext {
  chatId: number | string;
  from?: { id: number };
  msg: {
    caption?: string;
    photo: PhotoSize[];
  };
  reply(text: string, other?: Record<string, unknown>): Promise<unknown>;
  react(emoji: string): Promise<unknown>;
}

export interface DocumentMessageContext {
  chatId: number | string;
  from?: { id: number };
  msg: {
    caption?: string;
    document?: {
      file_id: string;
      mime_type?: string;
      file_name?: string;
    };
  };
  reply(text: string, other?: Record<string, unknown>): Promise<unknown>;
  react(emoji: string): Promise<unknown>;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isParseError(err: unknown): boolean {
  const msg = errMessage(err).toLowerCase();
  return (
    msg.includes("can't parse entities") ||
    msg.includes("unsupported start tag") ||
    msg.includes("unexpected end tag") ||
    msg.includes("entity name expected") ||
    msg.includes("parse entities") ||
    msg.includes("can't parse message text")
);

}

export function createSafeEditor(
  api: TelegramApi,
  chatId: number | string,
  firstMessageId: number,
  log?: (msg: string) => void,
) {
  const messageIds: number[] = [firstMessageId];
  const lastGoodTexts: string[] = [""];
  let frozenLength = 0;
  const mdOpts = { parse_mode: "MarkdownV2" as const };

  function isNotModifiedError(err: unknown): boolean {
    return errMessage(err).includes("message is not modified");
  }

  function isTooLongError(err: unknown): boolean {
    const msg = errMessage(err).toLowerCase();
    return msg.includes("message_too_long") || msg.includes("message is too long");
  }

  async function rollbackLastMessage(messageId: number, goodText: string): Promise<void> {
    try {
      await api.editMessageText(chatId, messageId, escapeText(goodText), mdOpts);
    } catch (err) {
      if (isNotModifiedError(err)) return;
      if (isParseError(err)) {
        try {
          await api.editMessageText(chatId, messageId, goodText);
        } catch (plainErr) {
          if (!isNotModifiedError(plainErr)) {
            log?.(`[telegram] plain rollback edit failed: ${errMessage(plainErr)}`);
          }
        }
        return;
      }
      log?.(`[telegram] rollback edit failed: ${errMessage(err)}`);
    }
  }

  async function sendChunk(text: string): Promise<{ message_id: number }> {
    try {
      return await api.sendMessage(chatId, escapeText(text), mdOpts);
    } catch (err) {
      if (isParseError(err)) {
        return await api.sendMessage(chatId, text);
      }
      throw err;
    }
  }

  return {
    async edit(fullText: string, isFinal?: boolean): Promise<void> {
      const candidate = fullText.slice(frozenLength);
      const lastIndex = messageIds.length - 1;
      const lastMessageId = messageIds[lastIndex]!;

      try {
        await api.editMessageText(chatId, lastMessageId, escapeText(candidate), mdOpts);
        lastGoodTexts[lastIndex] = candidate;
      } catch (err) {
        if (isNotModifiedError(err)) {
          return;
        }

        if (isTooLongError(err)) {
          const goodText = lastGoodTexts[lastIndex]!;
          if (goodText && goodText !== candidate) {
            await rollbackLastMessage(lastMessageId, goodText);
          }

          const remainder = candidate.slice(goodText.length);
          if (!remainder) return;

          let textToChunk = remainder;
          if (goodText && !goodText.endsWith('\n')) {
            const lastNewline = goodText.lastIndexOf('\n');
            const lastLine = lastNewline >= 0 ? goodText.slice(lastNewline + 1) : goodText;
            if (lastLine.startsWith('>') && !remainder.startsWith('>')) {
              textToChunk = '> ' + remainder;
            }
          }

          const chunks = splitTelegramText(textToChunk, 4000);

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]!;
            const isLastChunk = i === chunks.length - 1;
            try {
              const sent = await sendChunk(chunk);
              messageIds.push(sent.message_id);
              lastGoodTexts.push(chunk);
              if (!isLastChunk) {
                frozenLength += chunk.length;
              }
            } catch (sendErr) {
              log?.(`[telegram] send chunk failed: ${errMessage(sendErr)}`);
              throw sendErr;
            }
          }

          frozenLength += goodText.length;
          return;
        }

        if (isParseError(err)) {
          if (isFinal) {
            try {
              await api.editMessageText(chatId, lastMessageId, candidate);
            } catch (fallbackErr) {
              log?.(`[telegram] plain fallback edit failed: ${errMessage(fallbackErr)}`);
            }
          } else {
            log?.(`[telegram] parse error during streaming, will retry later: ${errMessage(err)}`);
          }
          return;
        }

        log?.(`[telegram] edit failed: ${errMessage(err)}`);
      }
    },
  };
}

export function splitTelegramText(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = remaining.lastIndexOf(" ", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length > 0 ? chunks : [""];
}

export function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatToolCall(args: unknown, toolName: string): string {
  let argStr = "";
  if (args != null) {
    const json = JSON.stringify(args);
    const max = 250;
    argStr = htmlEscape(json.length > max ? json.slice(0, max - 3) + "..." : json);
  }
  const tn = htmlEscape(toolName);
  return `<pre>\uD83D\uDD27 ${tn}${argStr ? `: ${argStr}` : ""}</pre>`;
}
