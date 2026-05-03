const _player = new (class {
  private _instance: TTSPlayer | null = null;
  get instance() {
    if (!this._instance) this._instance = new TTSPlayer();
    return this._instance;
  }
  reset() {
    if (this._instance) { this._instance.destroy(); this._instance = null; }
  }
})();

export function getTTSPlayer() { return _player.instance; }
export function resetTTSPlayer() { _player.reset(); }

function installAutoplayUnblock() {
  const handler = () => {
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    document.removeEventListener('click', handler, true);
    document.removeEventListener('keydown', handler, true);
  };
  document.addEventListener('click', handler, true);
  document.addEventListener('keydown', handler, true);
}

export class TTSPlayer {
  private ctx: AudioContext | null = null;
  private queue: AudioBuffer[] = [];
  private isPlaying = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private stopped = false;
  private unblocked = false;

  constructor() {
    installAutoplayUnblock();
  }

  private _ensureCtx(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  private async _resumeCtx(): Promise<boolean> {
    const ctx = this._ensureCtx();
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { return false; }
    }
    return ctx.state === 'running';
  }

  async enqueue(base64Audio: string) {
    if (this.stopped) return;
    const ready = await this._resumeCtx();
    if (!ready) {
      console.warn('[TTSPlayer] AudioContext suspended, autoplay may be blocked');
      return;
    }
    try {
      const binaryStr = atob(base64Audio);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const audioBuffer = await this._ensureCtx().decodeAudioData(bytes.buffer);
      this.queue.push(audioBuffer);
      if (!this.isPlaying) this._playNext();
    } catch (err) {
      console.warn('[TTSPlayer] decode chunk failed:', err);
    }
  }

  private _playNext() {
    if (this.stopped || this.queue.length === 0) {
      this.isPlaying = false;
      return;
    }
    this.isPlaying = true;
    const buffer = this.queue.shift()!;
    const source = this._ensureCtx().createBufferSource();
    source.buffer = buffer;
    source.connect(this._ensureCtx().destination);
    this.currentSource = source;
    source.onended = () => {
      if (this.currentSource === source) this.currentSource = null;
      this._playNext();
    };
    source.start();
  }

  stop() {
    this.stopped = true;
    this.queue = [];
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch {}
      this.currentSource = null;
    }
    this.isPlaying = false;
  }

  reset() {
    this.stopped = false;
    this.queue = [];
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch {}
      this.currentSource = null;
    }
    this.isPlaying = false;
  }

  destroy() {
    this.stop();
    if (this.ctx) { this.ctx.close(); this.ctx = null; }
  }
}
