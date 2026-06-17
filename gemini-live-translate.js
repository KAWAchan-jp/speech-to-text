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
const GEMINI_HANGOVER_SAMPLES = 16000; // 発話後この分(16kHz=1秒)は無音でも送り続け、語尾を保持する
// RMSがこの値未満なら無音と判定して送信しない。マイク感度スライダーで変更できる。
// 大きいほど鈍感（大きい声でないと拾わない）。デフォルトは少し鈍感めに設定。
var gemini_vad_threshold = 0.003;
const GEMINI_SENSITIVITY_DEFAULT = 6; // 感度スライダー(1=鈍感〜10=敏感)の初期値

// 感度スライダーの値(1〜10)を実際のRMS閾値に変換する。
// 10(敏感)=0.0008、1(鈍感)=0.006 の範囲で線形補間する。
function geminiSensitivityToThreshold(s) {
  const v = Math.max(1, Math.min(10, Number(s) || GEMINI_SENSITIVITY_DEFAULT));
  return 0.0008 + (10 - v) * (0.006 - 0.0008) / 9;
}

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
  // combo.disabled は使わない。disabled=true にすると Google Translate の
  // 内部翻訳エンジンが停止し、false に戻しても自動では再起動しないため。
  // マウス操作の防止は disabled_control の pointer-events: none で対応する。
}

// Gemini Live中はGoogle翻訳の対象要素(result_text_en)に一切触れないようにする。
//
// 新しいGoogle翻訳ウィジェットは <select class="goog-te-combo"> を生成せず
// （リンク＋メニュー方式）、JSから翻訳のON/OFFや再起動ができない。そこで
// 「result_text_enをGemini中に書き換えない」ことでGoogleの翻訳トラッキングを
// 壊さず保持する。Geminiの翻訳表示はnotranslateな専用要素(result_text_gemini)に
// 出し、result_text_enは隠すだけにする。これでOFF後は通常翻訳がそのまま継続する。
function suspendGoogleTranslate() {
  const en = document.getElementById('result_text_en');
  const gem = document.getElementById('result_text_gemini');
  if (en) en.style.display = 'none';
  if (gem) { gem.innerHTML = ''; gem.style.display = ''; }
}

// Gemini Live停止時にGemini専用表示を隠し、通常のresult_text_en表示へ戻す。
// result_text_enはGemini中に変更していないため、Google翻訳は継続したまま。
function resumeGoogleTranslate() {
  const en = document.getElementById('result_text_en');
  const gem = document.getElementById('result_text_gemini');
  if (gem) { gem.innerHTML = ''; gem.style.display = 'none'; }
  if (en) en.style.display = '';
}

// マイク感度スライダーから呼ばれる。閾値を更新し、稼働中ならワークレットへ反映する。
function updateGeminiSensitivity(slider) {
  gemini_vad_threshold = geminiSensitivityToThreshold(slider.value);
  localStorage.setItem('gemini_sensitivity', slider.value);
  const valEl = document.getElementById('value_gemini_sensitivity');
  if (valEl) valEl.textContent = slider.value;
  // AudioWorklet稼働中ならリアルタイムに閾値を送る（フォールバックは変数を直接参照）
  if (gemini_audio_ctx && gemini_audio_ctx._gemini_worklet_node) {
    gemini_audio_ctx._gemini_worklet_node.port.postMessage({ type: 'config', threshold: gemini_vad_threshold });
  }
}

// VAD（マイク送信状態）インジケータを更新する。
// sending=true: 発話を検知してAPIに送信中（緑）、false: 無音でスキップ中（グレー）。
// state省略時（停止時など）は待機表示に戻す。
function updateGeminiVadIndicator(sending, rms) {
  const el = document.getElementById('gemini_vad_indicator');
  if (!el) return;
  const label = el.querySelector('.gemini_vad_label');
  const fill = el.querySelector('.gemini_vad_meter_fill');
  if (sending === undefined) {
    el.classList.remove('sending', 'idle');
    if (label) label.textContent = '待機中';
    if (fill) fill.style.width = '0%';
    return;
  }
  el.classList.toggle('sending', sending);
  el.classList.toggle('idle', !sending);
  if (label) label.textContent = sending ? '送信中' : '無音';
  // RMSは概ね0〜0.1程度。視認しやすいよう適当に拡大してバー表示する
  if (fill) {
    const level = Math.min(100, Math.round((rms || 0) * 800));
    fill.style.width = level + '%';
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
  // マイク感度スライダーの復元（保存値がなければデフォルト）
  const sensSlider = document.getElementById('slider_gemini_sensitivity');
  if (sensSlider) {
    const savedSens = localStorage.getItem('gemini_sensitivity');
    sensSlider.value = (savedSens !== null) ? savedSens : GEMINI_SENSITIVITY_DEFAULT;
    gemini_vad_threshold = geminiSensitivityToThreshold(sensSlider.value);
    const valEl = document.getElementById('value_gemini_sensitivity');
    if (valEl) valEl.textContent = sensSlider.value;
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
  suspendGoogleTranslate(); // Google翻訳を原文表示にして一時停止（Geminiとの競合を防ぐ）
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

  gemini_ws.onopen = async () => {
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
    await startGeminiAudioCapture();
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
    // result_text_enには触れない（Google翻訳の状態を保持するため）。専用要素に表示する
    document.getElementById('result_text_gemini').innerHTML = gemini_output_acc;
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
    // Gemini中はresult_text_enに触れないため、専用要素を消す
    document.getElementById('result_text_gemini').innerHTML = '';
    gemini_input_acc = '';
    gemini_output_acc = '';
    gemini_turn_done = false;
    gemini_clear_timer = 0;
  }, sec * 1000);
}

// ---- マイク音声のキャプチャ・16kHz PCM16への変換・送信 ----

// AudioWorkletで音声処理する（メインスレッドをブロックしない）。
// AudioWorklet非対応の場合はScriptProcessorNodeで代替する。
async function startGeminiAudioCapture() {
  gemini_audio_ctx = new (window.AudioContext || window.webkitAudioContext)();
  const source = gemini_audio_ctx.createMediaStreamSource(gemini_mic_stream);
  gemini_audio_ctx._gemini_source = source;

  try {
    await gemini_audio_ctx.audioWorklet.addModule('gemini-audio-worklet.js');
    const workletNode = new AudioWorkletNode(gemini_audio_ctx, 'gemini-audio-processor');
    // 現在のマイク感度（閾値）をワークレットへ渡す
    workletNode.port.postMessage({ type: 'config', threshold: gemini_vad_threshold });
    workletNode.port.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        if (gemini_live_active) sendGeminiPcmBuffer(e.data);
      } else if (e.data && e.data.type === 'vad') {
        updateGeminiVadIndicator(e.data.sending, e.data.rms);
      }
    };
    source.connect(workletNode);
    workletNode.connect(gemini_audio_ctx.destination);
    gemini_audio_ctx._gemini_worklet_node = workletNode;
  } catch (e) {
    console.warn('AudioWorklet不可、ScriptProcessorNodeで代替:', e);
    startGeminiScriptProcessor(source);
  }
}

// ScriptProcessorNodeによる代替実装（AudioWorklet非対応時のフォールバック）
// ワークレット版と同じく、語尾を保持するためハングオーバーを設ける。
function startGeminiScriptProcessor(source) {
  const processor = gemini_audio_ctx.createScriptProcessor(4096, 1, 1);
  gemini_pcm_buffer = [];
  let hangover = 0; // 残り送信サンプル数（16kHz）
  processor.onaudioprocess = (e) => {
    if (!gemini_live_active) return;
    const input = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    const downsampled = downsampleBuffer(input, gemini_audio_ctx.sampleRate, 16000);
    if (rms >= gemini_vad_threshold) {
      hangover = GEMINI_HANGOVER_SAMPLES; // 発話中
      updateGeminiVadIndicator(true, rms);
    } else if (hangover > 0) {
      hangover -= downsampled.length;     // 発話直後の無音は語尾保持のため送る
      updateGeminiVadIndicator(true, rms);
    } else {
      updateGeminiVadIndicator(false, rms);
      return;                             // 続く無音は送らない（コスト節約）
    }
    for (let i = 0; i < downsampled.length; i++) {
      gemini_pcm_buffer.push(downsampled[i]);
    }
    while (gemini_pcm_buffer.length >= GEMINI_SEND_CHUNK_SAMPLES) {
      const chunk = gemini_pcm_buffer.splice(0, GEMINI_SEND_CHUNK_SAMPLES);
      sendGeminiAudioChunk(chunk);
    }
  };
  source.connect(processor);
  processor.connect(gemini_audio_ctx.destination);
  gemini_audio_ctx._gemini_processor = processor;
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
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function sendGeminiAudioChunk(samples) {
  if (!gemini_ws || gemini_ws.readyState !== WebSocket.OPEN) return;
  const pcm = floatTo16BitPCM(samples);
  gemini_ws.send(JSON.stringify({
    realtimeInput: {
      audio: {
        data: arrayBufferToBase64(pcm),
        mimeType: 'audio/pcm;rate=16000'
      }
    }
  }));
}

// AudioWorkletから受け取ったInt16 ArrayBufferをWebSocketで送信する
function sendGeminiPcmBuffer(int16Buffer) {
  if (!gemini_ws || gemini_ws.readyState !== WebSocket.OPEN) return;
  gemini_ws.send(JSON.stringify({
    realtimeInput: {
      audio: {
        data: arrayBufferToBase64(int16Buffer),
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
    if (gemini_audio_ctx._gemini_worklet_node) gemini_audio_ctx._gemini_worklet_node.disconnect();
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
  updateGeminiVadIndicator(); // インジケータを待機表示に戻す

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

  // Gemini Live中に付けていたnotranslateを外し、Google自動翻訳を再開させる。
  // 直前にresult_text_enをクリア済みなので、以降の認識結果から通常どおり翻訳される。
  resumeGoogleTranslate();

  // 通常の音声認識を再開する（main.js）
  if (restartRecognition && typeof vr_function === 'function') vr_function();
}
