// Gemini Live用音声処理ワークレット。
// メインスレッドをブロックしないよう、音声専用スレッドで動作する。
// 担当: VADによる無音区間スキップ・16kHzダウンサンプリング・PCM16変換・メインスレッドへの転送
//
// コスト節約と認識精度を両立するため、単純な無音スキップではなく
// 「プリロール＋ハングオーバー付きVAD」を使う:
//   - プリロール: 発話検出の少し前の音声も送り、語頭が切れないようにする
//   - ハングオーバー: 発話が途切れても一定時間は送信を続け、語尾や短い間（Gemini側VADが
//     文の区切り判定に使う無音）を保持する
//   - 長く続く無音だけ送信を止めてコストを抑える
class GeminiAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._threshold = 0.003;    // 無音判定RMS（メインスレッドの感度設定で上書きされる）
    this._chunkSamples = 1600;  // 16kHz × 100ms
    this._sendBuf = [];         // 送信待ちサンプル（16kHz）
    this._hangover = 0;         // 残り送信サンプル数（16kHz）。発話後この分は無音でも送る
    this._hangoverMax = 16000;  // 1秒
    this._preroll = [];         // 発話前の保持音声（16kHz）
    this._prerollMax = 4800;    // 300ms
    // VAD状態をメインスレッドへ通知するための間引き用（約100ms毎）
    this._statusAccum = 0;
    this._statusInterval = 0.1; // 秒
    // メインスレッドからの設定（マイク感度＝閾値）を受け取る
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'config' && typeof e.data.threshold === 'number') {
        this._threshold = e.data.threshold;
      }
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;

    // RMSで音量を測る
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / ch.length);

    // ネイティブサンプルレートから16kHzへ線形補間ダウンサンプリング
    const ratio = sampleRate / 16000;
    const outLen = Math.round(ch.length / ratio);
    const down = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const s = i * ratio;
      const sf = Math.floor(s);
      const t = s - sf;
      const a = ch[sf] || 0;
      const b = ch[sf + 1] || a;
      down[i] = a + (b - a) * t;
    }

    let sending;
    if (rms >= this._threshold) {
      // 発話中: 先にプリロール（語頭）を送信バッファへ移してから本体を積む
      for (let i = 0; i < this._preroll.length; i++) this._sendBuf.push(this._preroll[i]);
      this._preroll.length = 0;
      for (let i = 0; i < outLen; i++) this._sendBuf.push(down[i]);
      this._hangover = this._hangoverMax;
      sending = true;
    } else if (this._hangover > 0) {
      // 発話直後の無音: 語尾・短い間を保つため送信を継続する
      for (let i = 0; i < outLen; i++) this._sendBuf.push(down[i]);
      this._hangover -= outLen;
      sending = true;
    } else {
      // 続く無音: 送らずにプリロールへ蓄える（古い分は捨てる）。これでコストを抑える
      for (let i = 0; i < outLen; i++) this._preroll.push(down[i]);
      if (this._preroll.length > this._prerollMax) {
        this._preroll.splice(0, this._preroll.length - this._prerollMax);
      }
      sending = false;
    }

    // VAD状態（送信中か・音量）を約100ms毎にメインスレッドへ通知する
    this._statusAccum += ch.length / sampleRate;
    if (this._statusAccum >= this._statusInterval) {
      this._statusAccum = 0;
      this.port.postMessage({ type: 'vad', sending: sending, rms: rms });
    }

    // 100ms分たまったらPCM16に変換してメインスレッドへ転送
    while (this._sendBuf.length >= this._chunkSamples) {
      const chunk = this._sendBuf.splice(0, this._chunkSamples);
      const pcm = new Int16Array(this._chunkSamples);
      for (let i = 0; i < this._chunkSamples; i++) {
        const v = Math.max(-1, Math.min(1, chunk[i]));
        pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      // transferableとして転送（コピーなし）
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor('gemini-audio-processor', GeminiAudioProcessor);
