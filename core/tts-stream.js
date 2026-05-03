export class TTSStream {
  constructor({ text, voice, credentials, onChunk, onDone, onError, signal }) {
    this._text = text;
    this._voice = voice || "zh_female_vv_uranus_bigtts";
    this._credentials = credentials;
    this._onChunk = onChunk;
    this._onDone = onDone;
    this._onError = onError;
    this._abortController = new AbortController();
    this._done = false;

    if (signal) {
      signal.addEventListener("abort", () => this.abort(), { once: true });
    }
  }

  abort() {
    this._done = true;
    this._abortController.abort();
    if (this._onDone) this._onDone();
  }

  async start() {
    const { appId, accessToken, resourceId } = this._credentials;
    if (!appId || !accessToken) {
      const err = new Error("TTS 凭证未配置：缺少 appId 或 accessToken");
      if (this._onError) this._onError(err);
      throw err;
    }

    try {
      const response = await fetch(
        "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse",
        {
          method: "POST",
          headers: {
            "X-Api-App-Id": appId,
            "X-Api-Access-Key": accessToken,
            "X-Api-Resource-Id": resourceId || "seed-tts-2.0",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            user: { uid: "hanako" },
            req_params: {
              text: this._text,
              speaker: this._voice,
              audio_params: {
                format: "mp3",
                sample_rate: 24000,
                speech_rate: 0,
              },
            },
          }),
          signal: this._abortController.signal,
        }
      );

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`TTS API 错误 ${response.status}: ${body}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          this._processLine(line);
          if (this._done) return;
        }
      }

      if (!this._done && this._onDone) this._onDone();
    } catch (err) {
      if (err.name === "AbortError") return;
      if (this._onError) this._onError(err);
      throw err;
    }
  }

  _processLine(line) {
    if (!line.startsWith("data:")) return;
    try {
      const data = JSON.parse(line.slice(5).trim());
      if (data.code === 0 && data.data) {
        if (this._onChunk) this._onChunk(data.data);
      } else if (data.code === 20000000) {
        this._done = true;
        if (this._onDone) this._onDone();
      }
    } catch {
      // skip malformed lines
    }
  }
}

export async function startTTSStream(opts) {
  const stream = new TTSStream(opts);
  await stream.start();
  return stream;
}
