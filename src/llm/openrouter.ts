/**
 * Thin OpenRouter chat-completions client.
 * Contract: send one user prompt, get the assistant's text back.
 * Throws on HTTP errors, timeouts, and unexpected response shapes.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Image inputs can take noticeably longer than text-only calls.
const REQUEST_TIMEOUT_MS = 60_000;

export interface OpenRouterClient {
  /** imageDataUrl: optional base64 data URL (e.g. "data:image/jpeg;base64,..."). */
  complete(prompt: string, imageDataUrl?: string): Promise<string>;
}

export function createOpenRouterClient(options: {
  apiKey: string;
  model: string;
}): OpenRouterClient {
  return {
    async complete(prompt: string, imageDataUrl?: string): Promise<string> {
      const userContent = imageDataUrl
        ? [
            { type: "image_url", image_url: { url: imageDataUrl } },
            { type: "text", text: prompt },
          ]
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
