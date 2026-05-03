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
  /** 合并多少个 chunk 的 PCM 数据后再播放。越大边界越少，但首次播放延迟略增 */
  private static readonly MERGE_COUNT = 8;

  private ctx: AudioContext | null = null;
  /** 已解码但尚未合并/调度的 AudioBuffer */
  private pendingBuffers: AudioBuffer[] = [];
  /** 所有已调度的 AudioBufferSourceNode */
  private sources: AudioBufferSourceNode[] = [];
  /** 下一个合并块应开始播放的绝对时间 */
  private _nextStartTime = 0;
  /** 是否已经开始调度播放（首次合并后置 true） */
  private _started = false;
  private stopped = false;

  constructor() {
    installAutoplayUnblock();
  }

  private _ensureCtx(): AudioContext {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext({ sampleRate: 24000 });
      } catch {
        this.ctx = new AudioContext();
      }
    }
    return this.ctx;
  }

  private async _resumeCtx(): Promise<boolean> {
    const ctx = this._ensureCtx();
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { return false; }
    }
    return ctx.state === 'running';
  }

  private async _decodeBase64(base64: string): Promise<AudioBuffer> {
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return this._ensureCtx().decodeAudioData(bytes.buffer);
  }

  /** 裁剪 AudioBuffer 首尾的近零静音。threshold: Float32 振幅阈值（默认 0.001 ≈ 16-bit PCM 的 33）
   *  保留边缘 8ms，确保字尾的自然衰减不被切掉。 */
  private _trimSilence(buffer: AudioBuffer, threshold: number = 0.001): AudioBuffer {
    const ch0 = buffer.getChannelData(0);
    const len = ch0.length;

    // 找到第一个超过阈值的样本
    let start = 0;
    while (start < len && Math.abs(ch0[start]) < threshold) start++;

    // 找到最后一个超过阈值的样本
    let end = len - 1;
    while (end > start && Math.abs(ch0[end]) < threshold) end--;

    // 全部是静音或几乎静音，返回空数据
    if (start >= end) {
      const ctx = this._ensureCtx();
      return ctx.createBuffer(buffer.numberOfChannels, 1, buffer.sampleRate);
    }

    // 保留 8ms 的边缘样本，保护字尾自然衰减
    const padSamples = Math.min(Math.floor(buffer.sampleRate * 0.008), Math.floor((end - start) * 0.25));
    const adjStart = Math.max(0, start - padSamples);
    const adjEnd = Math.min(len, end + padSamples);
    const newLen = adjEnd - adjStart;

    const ctx = this._ensureCtx();
    const trimmed = ctx.createBuffer(buffer.numberOfChannels, newLen, buffer.sampleRate);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const src = buffer.getChannelData(ch);
      const dst = trimmed.getChannelData(ch);
      for (let i = adjStart; i < adjEnd; i++) {
        dst[i - adjStart] = src[i];
      }
    }

    return trimmed;
  }

  /**
   * 把 pendingBuffers 中所有 chunk 的 PCM 数据合并成一个 AudioBuffer。
   * 每个 chunk 先裁剪首尾静音，合并后内部无边界。
   */
  private _mergeAndSchedule() {
    if (this.pendingBuffers.length === 0) return;

    const buffers = this.pendingBuffers;
    this.pendingBuffers = [];

    const sampleRate = buffers[0].sampleRate;
    const channels = buffers[0].numberOfChannels;
    let totalSamples = 0;
    for (const buf of buffers) {
      totalSamples += buf.length;
    }

    const ctx = this._ensureCtx();
    const merged = ctx.createBuffer(channels, totalSamples, sampleRate);

    for (let ch = 0; ch < channels; ch++) {
      const dest = merged.getChannelData(ch);
      let offset = 0;
      for (const buf of buffers) {
        dest.set(buf.getChannelData(ch), offset);
        offset += buf.length;
      }
    }

    // 用绝对时间调度合并后的整块
    const now = ctx.currentTime;
    const when = Math.max(now, this._nextStartTime);
    const source = ctx.createBufferSource();
    source.buffer = merged;
    source.connect(ctx.destination);
    source.start(when);
    this.sources.push(source);
    this._nextStartTime = when + merged.duration;

    source.onended = () => {
      const idx = this.sources.indexOf(source);
      if (idx !== -1) this.sources.splice(idx, 1);
    };
  }

  async enqueue(base64Audio: string) {
    if (this.stopped) return;
    const ready = await this._resumeCtx();
    if (!ready) {
      console.warn('[TTSPlayer] AudioContext suspended, autoplay may be blocked');
      return;
    }

    try {
      const audioBuffer = await this._decodeBase64(base64Audio);
      const trimmed = this._trimSilence(audioBuffer);
      this.pendingBuffers.push(trimmed);

      // 攒够 MERGE_COUNT 个 chunk 后合并一次
      if (this.pendingBuffers.length >= TTSPlayer.MERGE_COUNT) {
        this._started = true;
        this._mergeAndSchedule();
      }
    } catch (err) {
      console.warn('[TTSPlayer] decode chunk failed:', err);
    }
  }

  /** 流结束时，把剩余不足 MERGE_COUNT 的块也合并播放 */
  flush() {
    if (this.pendingBuffers.length === 0) return;
    this._started = true;
    this._mergeAndSchedule();
  }

  stop() {
    this.stopped = true;
    this.pendingBuffers = [];
    for (const source of this.sources) {
      try { source.stop(); } catch { /* 可能已播完 */ }
    }
    this.sources = [];
  }

  reset() {
    this.stop();
    this.stopped = false;
    this._started = false;
    this._nextStartTime = 0;
  }

  destroy() {
    this.stop();
    if (this.ctx) { this.ctx.close(); this.ctx = null; }
  }
}
