export default class TTSPlugin {
  async onload() {
    const { log } = this.ctx;
    log.info("tts-plugin loaded");
  }
}
