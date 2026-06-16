// Gemini Live APIによる音声→音声リアルタイム翻訳。
// マイク音声を16kHz PCM16でWebSocketに送り、翻訳音声(24kHz)と字幕を受け取る。
// 有効化中は通常のWeb Speech認識・Googleページ翻訳・ブラウザTTSは停止する。
//
// 接続方式（PowerShellでの実機検証で確定）:
//   - エンドポイント: v1beta + key=（access_token方式は「Please use API Key」で拒否される）
//   - inputAudioTranscription/outputAudioTranscription は setup 直下（generationConfig内ではない）
//   - サーバー応答は Binary フレームでJSONが届くので、ArrayBufferをデコードしてからparseする
//
// APIキーは画面の入力欄、または gemini-live-translate.config.js の GEMINI_API_KEY を使う。

var gemini_live_active = false; // 有効中はmain.js側のWeb Speech認識(vr_function)を止める
var gemini_ws = null;
var gemini_audio_ctx = null;    // マイク入力キャプチャ用 AudioContext（ネイティブのサンプルレート）
var gemini_playback_ctx = null; // 翻訳音声の再生用 AudioContext（24kHz）
var gemini_playback_time = 0;   // 再生キューの次回開始時刻（チャンクを途切れなく繋げるため）
var gemini_mic_stream = null;
var gemini_pcm_buffer = [];     // 16kHzにダウンサンプリング済みでまだ送信していないサンプル
var gemini_reconnect_timer = 0;
var gemini_reconnecting = false;
const GEMINI_SEND_CHUNK_SAMPLES = 1600; // 16kHz * 100ms分のサンプル数

// 文字起こしは差分で届くため、ターンごとに連結して表示する
var gemini_input_acc = '';   // 原文（認識）の累積
var gemini_output_acc = '';  // 翻訳の累積
var gemini_turn_done = false; // 直前のターンが完了したか（次の字幕が来たらクリアする）
var gemini_clear_timer = 0;   // 「自動消去」用タイマーID
const GEMINI_DEFAULT_MODEL = 'models/gemini-3.5-live-translate-preview';
const GEMINI_KNOWN_MODELS = [
  'models/gemini-3.5-live-translate-preview',
  'models/gemini-live-2.5-flash-preview'
];
const GEMINI_UNSUPPORTED_BIDI_MODELS = [
  'models/gemini-live-2.5-flash-preview'
];

// 使用するキーを決める。入力欄を優先し、空ならconfig.jsのGEMINI_API_KEYを使う。
function getGeminiKey() {
  const input = document.getElementById('input_gemini_token');
  if (input && input.value.trim()) return input.value.trim();
  if (typeof GEMINI_API_KEY !== 'undefined' && GEMINI_API_KEY) return GEMINI_API_KEY;
  return '';
}

function normalizeGeminiModelName(model) {
  const value = (model || '').trim();
  if (!value) return GEMINI_DEFAULT_MODEL;
  if (value === 'custom') return 'custom';
  const normalized = value.startsWith('models/') ? value : 'models/' + value;
  if (GEMINI_KNOWN_MODELS.includes(normalized)) return normalized;
  return normalized;
}

function getGeminiModel() {
  const select = document.getElementById('select_gemini_model');
  if (!select || select.value !== 'custom') {
    return (select && select.value) || GEMINI_DEFAULT_MODEL;
  }
  return normalizeGeminiModelName(document.getElementById('input_gemini_model').value);
}

function setGoogleTranslateUiEnabled(enabled) {
  const wrapper = document.getElementById('google_translate_element');
  if (wrapper) {
    wrapper.classList.toggle('disabled_control', !enabled);
    wrapper.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    wrapper.title = enabled ? '' : 'Gemini Live 翻訳が有効な間は Google 翻訳を変更できません';
  }
  const combo = document.querySelector('.goog-te-combo');
  if (combo) {
    combo.disabled = !enabled;
  }
}

function resetGeminiModelSelection(model) {
  const modelSelect = document.getElementById('select_gemini_model');
  if (!modelSelect) return;
  if (selectValueIfExists(modelSelect, model)) {
    modelSelect.value = model;
    localStorage.setItem('gemini_model_select', model);
    updateGeminiModelSelection(modelSelect);
  }
}

async function restartGeminiLiveIfActive() {
  if (!gemini_live_active) return;
  stopGeminiLive({ restartRecognition: false });
  await startGeminiLive();
}

function scheduleGeminiLiveReconnect(reason, delayMs = 1000) {
  const checkbox = document.getElementById('checkbox_gemini_live');
  const shouldReconnect = gemini_live_active || (checkbox && checkbox.checked);
  if (!shouldReconnect || gemini_reconnect_timer) return;
  console.warn('Gemini Live reconnect scheduled:', reason);
  gemini_live_active = true;
  gemini_reconnecting = true;
  document.getElementById('status').innerHTML = "Gemini Live 再接続中...";
  document.getElementById('status').className = "processing";
  closeGeminiLiveConnection();
  gemini_reconnect_timer = setTimeout(async function() {
    gemini_reconnect_timer = 0;
    gemini_reconnecting = false;
    if (checkbox && !checkbox.checked) {
      gemini_live_active = false;
      return;
    }
    await startGeminiLive();
  }, delayMs);
}

function isGeminiGoAwayClose(event) {
  const reason = (event && event.reason ? event.reason : '').toLowerCase();
  return event && (
    reason.includes('goaway') ||
    reason.includes('go away') ||
    reason.includes('session durat') ||
    reason.includes('failed to close the connection')
  );
}

function updateGeminiModelSelection(select) {
  const customInput = document.getElementById('input_gemini_model');
  if (!customInput) return;
  const customField = customInput.closest('.gemini_model_custom');
  if (customField) {
    customField.style.display = select.value === 'custom' ? 'grid' : 'none';
  } else {
    customInput.style.display = select.value === 'custom' ? 'inline-block' : 'none';
  }
  localStorage.setItem('gemini_model_select', select.value);
  localStorage.setItem('gemini_model_custom', customInput.value.trim());
  restartGeminiLiveIfActive();
}

// Gemini Liveの設定をブラウザ(localStorage)に保存し、リロード後も復元する。
// ※APIキーは平文でこのブラウザに保存される。共有PCでは使わないこと。
(function initGeminiSettingsPersistence() {
  const keyInput = document.getElementById('input_gemini_token');
  const modelSelect = document.getElementById('select_gemini_model');
  const modelInput = document.getElementById('input_gemini_model');
  const langSelect = document.getElementById('select_gemini_live_lang');
  const audioCheckbox = document.getElementById('checkbox_gemini_audio');
  if (keyInput) {
    const savedKey = localStorage.getItem('gemini_api_key');
    if (savedKey) keyInput.value = savedKey;
    keyInput.addEventListener('input', function() {
      localStorage.setItem('gemini_api_key', keyInput.value.trim());
    });
  }
  if (modelSelect && modelInput) {
    let savedSelect = normalizeGeminiModelName(localStorage.getItem('gemini_model_select'));
    const savedCustom = localStorage.getItem('gemini_model_custom');
    if (savedCustom) modelInput.value = savedCustom;
    if (savedSelect === 'custom') {
      modelSelect.value = 'custom';
      localStorage.setItem('gemini_model_select', 'custom');
    } else if (savedSelect && !selectValueIfExists(modelSelect, savedSelect)) {
      savedSelect = GEMINI_DEFAULT_MODEL;
    }
    if (savedSelect !== 'custom' && savedSelect && selectValueIfExists(modelSelect, savedSelect)) {
      modelSelect.value = savedSelect;
      localStorage.setItem('gemini_model_select', savedSelect);
    }
    updateGeminiModelSelection(modelSelect);
    modelSelect.addEventListener('change', function() {
      updateGeminiModelSelection(modelSelect);
    });
    modelInput.addEventListener('input', function() {
      localStorage.setItem('gemini_model_custom', modelInput.value.trim());
    });
  }
  if (langSelect) {
    const savedLang = localStorage.getItem('gemini_target_lang');
    if (savedLang && selectValueIfExists(langSelect, savedLang)) {
      langSelect.value = savedLang;
    }
    langSelect.addEventListener('change', function() {
      localStorage.setItem('gemini_target_lang', langSelect.value);
      restartGeminiLiveIfActive();
    });
  }
  if (audioCheckbox) {
    const savedAudioEnabled = localStorage.getItem('gemini_audio_enabled');
    if (savedAudioEnabled !== null) {
      audioCheckbox.checked = savedAudioEnabled === '1';
      updateGeminiAudioEnabled(audioCheckbox);
    }
  }
  setGoogleTranslateUiEnabled(!gemini_live_active);
})();

// チェックボックスのトグルから呼ばれる
function updateGeminiLiveEnabled(checkbox) {
  if (checkbox.checked) {
    startGeminiLive();
  } else {
    stopGeminiLive();
  }
}

// 「翻訳音声を再生」トグル。オフにしたら再生中・再生待ちの音声を即座に止める。
function updateGeminiAudioEnabled(checkbox) {
  localStorage.setItem('gemini_audio_enabled', checkbox.checked ? '1' : '0');
  if (!checkbox.checked && gemini_playback_ctx) {
    gemini_playback_ctx.close();
    gemini_playback_ctx = null;
  }
}

async function startGeminiLive() {
  const apiKey = getGeminiKey();
  if (!apiKey) {
    alert('Gemini APIキー/トークンを入力欄に貼り付けるか、gemini-live-translate.config.js に設定してください。');
    document.getElementById('checkbox_gemini_live').checked = false;
    return;
  }

  const targetLang = document.getElementById('select_gemini_live_lang').value;
  const model = getGeminiModel();
  if (GEMINI_UNSUPPORTED_BIDI_MODELS.includes(model)) {
    alert(model + ' は現在の Live Translate 接続では使えません。gemini-3.5-live-translate-preview に戻します。');
    resetGeminiModelSelection(GEMINI_DEFAULT_MODEL);
    document.getElementById('checkbox_gemini_live').checked = false;
    return;
  }

  // 通常の音声認識・読み上げを止める
  gemini_live_active = true;
  setGoogleTranslateUiEnabled(false);
  gemini_input_acc = '';
  gemini_output_acc = '';
  gemini_turn_done = false;
  if (recognition) recognition.stop();
  if (typeof tts_enabled !== 'undefined' && tts_enabled) speechSynthesis.cancel();

  document.getElementById('status').innerHTML = "Gemini Live 接続中...";
  document.getElementById('status').className = "processing";

  try {
    gemini_mic_stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert('マイクの取得に失敗しました: ' + e.message);
    gemini_live_active = false;
    setGoogleTranslateUiEnabled(true);
    document.getElementById('checkbox_gemini_live').checked = false;
    return;
  }

  const url = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=' + apiKey;
  gemini_ws = new WebSocket(url);
  gemini_ws.binaryType = 'arraybuffer'; // サーバーはBinaryフレームでJSONを返す

  gemini_ws.onopen = () => {
    gemini_ws.send(JSON.stringify({
      setup: {
        model: model,
        generationConfig: {
          responseModalities: ['AUDIO'],
          translationConfig: {
            targetLanguageCode: targetLang,
            echoTargetLanguage: true
          }
        },
        // transcription系はsetup直下が正しい階層
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    }));
    startGeminiAudioCapture();
    document.getElementById('status').innerHTML = "Gemini Live 翻訳中...";
    document.getElementById('status').className = "ready";
  };

  gemini_ws.onmessage = async (event) => {
    let text;
    if (typeof event.data === 'string') {
      text = event.data;
    } else if (event.data instanceof ArrayBuffer) {
      text = new TextDecoder('utf-8').decode(event.data);
    } else if (event.data instanceof Blob) {
      text = await event.data.text();
    } else {
      return;
    }
    let response;
    try {
      response = JSON.parse(text);
    } catch (e) {
      console.warn('Gemini Live: 解析できないメッセージ', text);
      return;
    }
    if (response.goAway) {
      scheduleGeminiLiveReconnect('goAway');
      return;
    }
    handleGeminiMessage(response);
  };

  gemini_ws.onerror = (e) => {
    console.error('Gemini Live WebSocketエラー', e);
    document.getElementById('status').innerHTML = "Gemini Live エラー";
    document.getElementById('status').className = "error";
  };

  gemini_ws.onclose = (e) => {
    console.error('Gemini Live WebSocket切断', 'code=' + e.code, 'reason=' + e.reason);
    if (gemini_reconnecting) return;
    if (isGeminiGoAwayClose(e)) {
      scheduleGeminiLiveReconnect(e.reason || 'goAway close');
      return;
    }
    if (gemini_live_active) {
      const detail = e.reason ? (e.code + ': ' + e.reason) : ('code ' + e.code);
      document.getElementById('status').innerHTML = "Gemini Live 切断 (" + detail + ")";
      document.getElementById('status').className = "error";
      if (e.code === 1008 && model === 'models/gemini-live-2.5-flash-preview') {
        resetGeminiModelSelection(GEMINI_DEFAULT_MODEL);
      }
    }
  };
}

function handleGeminiMessage(response) {
  // setupComplete は接続確立の合図（何もしない）
  const content = response.serverContent;
  if (!content) return;

  // 新しいターンの最初の字幕が来たら、前のターンの内容をクリアして新規に積み直す
  const hasTranscript = (content.inputTranscription && content.inputTranscription.text) ||
                        (content.outputTranscription && content.outputTranscription.text);
  if (gemini_turn_done && hasTranscript) {
    gemini_input_acc = '';
    gemini_output_acc = '';
    gemini_turn_done = false;
  }

  if (content.inputTranscription && content.inputTranscription.text) {
    gemini_input_acc += content.inputTranscription.text;
    document.getElementById('result_text').innerHTML = gemini_input_acc;
  }
  if (content.outputTranscription && content.outputTranscription.text) {
    gemini_output_acc += content.outputTranscription.text;
    document.getElementById('result_text_en').innerHTML = gemini_output_acc;
  }
  // 字幕が更新されたら「自動消去」のタイマーを引き直す
  if (hasTranscript) {
    geminiSetClearTimer();
  }
  // 翻訳音声の再生（「翻訳音声を再生」がオンのときだけ鳴らす）
  const audioCheckbox = document.getElementById('checkbox_gemini_audio');
  const playAudio = !audioCheckbox || audioCheckbox.checked;
  if (playAudio && content.modelTurn && content.modelTurn.parts) {
    content.modelTurn.parts.forEach(part => {
      if (part.inlineData && part.inlineData.data) {
        playGeminiAudioChunk(part.inlineData.data);
      }
    });
  }

  // ターン完了。次の字幕が来たタイミングでクリアする（完了文はそれまで表示したまま）
  if (content.turnComplete) {
    gemini_turn_done = true;
  }
}

// 「自動消去」セレクタ(main.jsのtextUpdateTimeoutSecond)に従って字幕を消すタイマーを引き直す。
// 値が0以下（「なし」）のときは消去しない。
function geminiSetClearTimer() {
  if (gemini_clear_timer) {
    clearTimeout(gemini_clear_timer);
    gemini_clear_timer = 0;
  }
  const sec = (typeof textUpdateTimeoutSecond !== 'undefined') ? textUpdateTimeoutSecond : 0;
  if (sec <= 0) return;
  gemini_clear_timer = setTimeout(function() {
    document.getElementById('result_text').innerHTML = '';
    document.getElementById('result_text_en').innerHTML = '';
    gemini_input_acc = '';
    gemini_output_acc = '';
    gemini_turn_done = false;
    gemini_clear_timer = 0;
  }, sec * 1000);
}

// ---- マイク音声のキャプチャ・16kHz PCM16への変換・送信 ----

function startGeminiAudioCapture() {
  gemini_audio_ctx = new (window.AudioContext || window.webkitAudioContext)();
  const source = gemini_audio_ctx.createMediaStreamSource(gemini_mic_stream);
  // ScriptProcessorNodeは非推奨だが、実装を単一ファイルで完結させるためここでは使用する
  const processor = gemini_audio_ctx.createScriptProcessor(4096, 1, 1);
  gemini_pcm_buffer = [];

  processor.onaudioprocess = (e) => {
    if (!gemini_live_active) return;
    const input = e.inputBuffer.getChannelData(0);
    const downsampled = downsampleBuffer(input, gemini_audio_ctx.sampleRate, 16000);
    for (let i = 0; i < downsampled.length; i++) {
      gemini_pcm_buffer.push(downsampled[i]);
    }
    while (gemini_pcm_buffer.length >= GEMINI_SEND_CHUNK_SAMPLES) {
      const chunk = gemini_pcm_buffer.splice(0, GEMINI_SEND_CHUNK_SAMPLES);
      sendGeminiAudioChunk(chunk);
    }
  };

  source.connect(processor);
  // Chromeの仕様上、destinationに接続しないとonaudioprocessが発火しないことがある
  processor.connect(gemini_audio_ctx.destination);
  gemini_audio_ctx._gemini_processor = processor; // 終了時に切断するため保持
  gemini_audio_ctx._gemini_source = source;
}

// Float32の音声サンプル列を線形補間でリサンプリングする簡易実装
function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
  if (outputSampleRate === inputSampleRate) return buffer;
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const t = srcIndex - srcIndexFloor;
    const a = buffer[srcIndexFloor] || 0;
    const b = buffer[srcIndexFloor + 1] || a;
    result[i] = a + (b - a) * t;
  }
  return result;
}

function floatTo16BitPCM(floatSamples) {
  const buffer = new ArrayBuffer(floatSamples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < floatSamples.length; i++) {
    const s = Math.max(-1, Math.min(1, floatSamples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); // little-endian
  }
  return buffer;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function sendGeminiAudioChunk(samples) {
  if (!gemini_ws || gemini_ws.readyState !== WebSocket.OPEN) return;
  const pcm = floatTo16BitPCM(samples);
  const base64 = arrayBufferToBase64(pcm);
  gemini_ws.send(JSON.stringify({
    realtimeInput: {
      audio: {
        data: base64,
        mimeType: 'audio/pcm;rate=16000'
      }
    }
  }));
}

// ---- 翻訳音声（24kHz PCM16）の再生 ----

function playGeminiAudioChunk(base64Data) {
  if (!gemini_playback_ctx) {
    gemini_playback_ctx = new (window.AudioContext || window.webkitAudioContext)();
    gemini_playback_time = gemini_playback_ctx.currentTime;
  }
  const binary = window.atob(base64Data);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const sampleCount = len / 2;
  const audioBuffer = gemini_playback_ctx.createBuffer(1, sampleCount, 24000);
  const channel = audioBuffer.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) {
    channel[i] = view.getInt16(i * 2, true) / 0x8000;
  }

  const source = gemini_playback_ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(gemini_playback_ctx.destination);

  // 前のチャンクの再生終了時刻に合わせて開始することで、途切れなく繋げて再生する
  const startAt = Math.max(gemini_playback_time, gemini_playback_ctx.currentTime);
  source.start(startAt);
  gemini_playback_time = startAt + audioBuffer.duration;
}

// ---- 終了処理 ----

function closeGeminiLiveConnection() {
  if (gemini_ws) {
    if (gemini_ws.readyState === WebSocket.OPEN || gemini_ws.readyState === WebSocket.CONNECTING) {
      gemini_ws.close(1000, 'client reconnect');
    }
    gemini_ws = null;
  }
  if (gemini_audio_ctx) {
    if (gemini_audio_ctx._gemini_processor) gemini_audio_ctx._gemini_processor.disconnect();
    if (gemini_audio_ctx._gemini_source) gemini_audio_ctx._gemini_source.disconnect();
    gemini_audio_ctx.close();
    gemini_audio_ctx = null;
  }
  if (gemini_playback_ctx) {
    gemini_playback_ctx.close();
    gemini_playback_ctx = null;
  }
  if (gemini_mic_stream) {
    gemini_mic_stream.getTracks().forEach(track => track.stop());
    gemini_mic_stream = null;
  }
  gemini_pcm_buffer = [];
}

function stopGeminiLive(options) {
  const restartRecognition = !options || options.restartRecognition !== false;
  gemini_live_active = false;
  gemini_reconnecting = false;
  setGoogleTranslateUiEnabled(true);

  if (gemini_reconnect_timer) {
    clearTimeout(gemini_reconnect_timer);
    gemini_reconnect_timer = 0;
  }

  if (gemini_clear_timer) {
    clearTimeout(gemini_clear_timer);
    gemini_clear_timer = 0;
  }

  closeGeminiLiveConnection();

  document.getElementById('result_text').innerHTML = '';
  document.getElementById('result_text_en').innerHTML = '';
  document.getElementById('status').innerHTML = "停止中";
  document.getElementById('status').className = "error";

  // 通常の音声認識を再開する（main.js）
  if (restartRecognition && typeof vr_function === 'function') vr_function();
}
