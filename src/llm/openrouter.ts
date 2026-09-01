/**
 * Thin OpenRouter chat-completions client.
 * Contract: send one user prompt, get the assistant's text back.
 * Throws on HTTP errors, timeouts, and unexpected response shapes.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Image inputs can take noticeably longer than text-only calls.
const REQUEST_TIMEOUT_MS = 60_000;

export type LlmAttachment =
  | { type: "image"; dataUrl: string } // base64 data URL, e.g. "data:image/jpeg;base64,..."
  | { type: "audio"; base64Data: string; format: string }; // bare base64 + format like "ogg", "mp3"

export interface OpenRouterClient {
  complete(prompt: string, attachment?: LlmAttachment): Promise<string>;
}

/**
 * Normalizes an audio MIME type (possibly with codec params) to the short
 * format name the input_audio content part expects.
 */
export function audioFormatFromMimeType(mimeType: string): string {
  const bare = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const known: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/aac": "aac",
    "audio/mp4": "aac",
    "audio/x-m4a": "aac",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
  };
  return known[bare] ?? bare.replace(/^audio\//, "");
}

export function createOpenRouterClient(options: {
  apiKey: string;
  model: string;
}): OpenRouterClient {
  return {
    async complete(prompt: string, attachment?: LlmAttachment): Promise<string> {
      const userContent = attachment
        ? [attachmentContentPart(attachment), { type: "text", text: prompt }]
        : prompt;
      const response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          messages: [{ role: "user", content: userContent }],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "<unreadable body>");
        throw new Error(
          `OpenRouter request failed: ${response.status} ${response.statusText}: ${body.slice(0, 500)}`,
        );
      }

      const data = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error(
          `OpenRouter response missing message content: ${JSON.stringify(data).slice(0, 500)}`,
        );
      }
      return content;
    },
  };
}

function attachmentContentPart(attachment: LlmAttachment): object {
  return attachment.type === "image"
    ? { type: "image_url", image_url: { url: attachment.dataUrl } }
    : {
        type: "input_audio",
        input_audio: { data: attachment.base64Data, format: attachment.format },
      };
}
