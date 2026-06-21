// 旧バージョンで登録したService Workerを解除する
// （空実装で意味がなかったため廃止。登録済みユーザーのブラウザから取り除くための処理で、
// 　十分に行き渡ったらこのブロックごと削除してよい）
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      registration.unregister();
    }
  });
}

const TYPE_BROWSER = 'browser_';
const TYPE_INAPP = 'inapp_';
const TYPE_SPECIAL = 'special_';
const TYPE_UNKNOWN = 'unknown_';

/**
 * ブラウザを可能な範囲で判別する。
 * （参考）
 * https://zenn.dev/kecy/articles/f51851e42c4243
 * https://qiita.com/nightyknite/items/b2590a69f2e0135756dc
 * @return {string} 判別結果（基本的な形式は「type_name」。typeは単体ブラウザ（browser）かアプリ内ブラウザ（inapp）。nameはブラウザ名。
 */
function detectBrowser() {
  const ua = window.navigator.userAgent.toLowerCase().trim();

  // 特殊なプラットフォーム
  if (ua.includes('silk')) return TYPE_SPECIAL + 'silk';
  if (ua.includes('aftb')) return TYPE_SPECIAL + 'firetv';
  if (ua.includes('nintendo')) return TYPE_SPECIAL + 'nintendo';
  if (ua.includes('playstation')) return TYPE_SPECIAL + 'playstation';
  if (ua.includes('xbox')) return TYPE_SPECIAL + 'xbox';

  // 各種の「独自ブラウザ」
  if (ua.includes('samsung')) return TYPE_BROWSER + 'Samsung';
  if (ua.includes('ucbrowser')) return TYPE_BROWSER + 'UC Browser';
  if (ua.includes('qqbrowser')) return TYPE_BROWSER + 'QQ Browser';
  if (ua.includes('yabrowser')) return TYPE_BROWSER + 'Yandex';
  if (ua.includes('whale')) return TYPE_BROWSER + 'Whale';
  if (ua.includes('puffin')) return TYPE_BROWSER + 'Puffin';
  if (ua.includes('opr')) return TYPE_BROWSER + 'Opera';
  if (ua.includes('coc_coc')) return TYPE_BROWSER + 'Cốc Cốc';

  // アプリ内ブラウザ
  if (ua.includes('yahoo') || ua.includes('yjapp')) return TYPE_INAPP + 'Yahoo';
  if (ua.includes('fban') || ua.includes('fbios')) return TYPE_INAPP + 'Facebook';
  if (ua.includes('instagram')) return TYPE_INAPP + 'Instagram';
  if (ua.includes('line')) return TYPE_INAPP + 'LINE';
  if (ua.includes('cfnetwork')) return TYPE_INAPP + 'iOS app';
  if (ua.includes('dalvik')) return TYPE_INAPP + 'Android app';
  if (ua.includes('wv)')) return TYPE_INAPP + 'Android WebView';

  // 特殊なブラウザ
  if (ua.includes('crios')) return TYPE_BROWSER + 'Chrome(iOS)';
  if (ua.includes('fxios')) return TYPE_BROWSER + 'Firefox(iOS)';

  // 一般のブラウザ
  if (ua.includes('trident') || ua.includes('msie')) return TYPE_BROWSER + 'IE';
  if (ua.includes('edge')) return TYPE_BROWSER + 'EdgeHTML';
  if (ua.includes('edg')) return TYPE_BROWSER + 'Edge';
  if (ua.includes('firefox')) return TYPE_BROWSER + 'Firefox';

  // 一般のブラウザのうち、UserAgentが他で流用されすぎたもの（最後に配置する）
  if (ua.includes('chrome')) return TYPE_BROWSER + 'Chrome';
  if (ua.includes('safari')) return TYPE_BROWSER + 'Safari';

  // いずれにも当てはまらない場合
  return TYPE_UNKNOWN + "unknown";
}

/**
 * ブラウザが音声認識をサポートすると自己申告しているか判別する。
 * 具体的には SpeechRecognition または webkitSpeechRecognition オブジェクトの存在を判定している。
 * @returns {boolean} ブラウザが音声認識をサポートすると自己申告していればtrue
 */
function is_speech_recognition_supported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

const browser = detectBrowser();
const is_inapp = (browser.indexOf(TYPE_INAPP) == 0);
const isnot_supported = (is_speech_recognition_supported() != true);
console.log(`Detected Browser : ${browser} / Speech recognition NOT-support : ${isnot_supported}`);
if (is_inapp || isnot_supported) {
  const errorMessage = 'Google Chrome や Microsoft Edge のような音声認識対応ブラウザでアクセスしてください。';
  alert(errorMessage);
  document.getElementById('status').innerHTML = errorMessage;
  document.getElementById('status').className = "error";
  // exit;
} else if (browser.indexOf('Safari') > 0) {
  alert('Safari は音声認識で問題が起こりやすいので、Google Chrome の使用をおすすめします。');
}

// select要素のoptionに、option.valueがvalueな項目があれば選択する
// 戻り値は、option中に該当項目があればtrue
function selectValueIfExists(select, value) {
  if (value === null || value === undefined) return;
  var result = false;
  select.childNodes.forEach(n => {
    if (n.value === value) {
      select.value = value;
      result = true;
    }
  })
  return result;
}

// 保存済み設定（localStorage）。各種関数より先に初期化する必要があるため先頭で宣言する。
// （speechSynthesis.onvoiceschanged等が読み込み中に早期発火し、configを参照することがあるため）
const config = JSON.parse(localStorage.speech_to_text_config || '{}');

// 音声認識
// 参考: https://jellyware.jp/kurage/iot/webspeechapi.html
var flag_speech = 0;
var recognition;
var lang = 'ja-JP';
var last_finished = ''; // 最後に確定した部分。確定部分が瞬時に消えるのを防ぐためにここで定義。
var textUpdateTimeoutID = 0;
var textUpdateTimeoutSecond = 30; // 音声認識結果が更新されない場合にクリアするまでの秒数（0以下の場合は自動クリアしない）
var recognitionRestartTimeoutID = 0;
var recognitionActive = false;

function restartRecognitionSoon(delayMs = 500) {
  if (typeof gemini_live_active !== 'undefined' && gemini_live_active) return;
  if (recognitionRestartTimeoutID) {
    clearTimeout(recognitionRestartTimeoutID);
  }
  recognitionRestartTimeoutID = setTimeout(function() {
    recognitionRestartTimeoutID = 0;
    vr_function();
  }, delayMs);
}

function vr_function() {
  // Gemini Live 翻訳が有効な間はWeb Speech認識を起動しない
  if (typeof gemini_live_active !== 'undefined' && gemini_live_active) return;
  if (recognitionActive) return;
  if (recognitionRestartTimeoutID) {
    clearTimeout(recognitionRestartTimeoutID);
    recognitionRestartTimeoutID = 0;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    document.getElementById('status').innerHTML = 'Google Chrome や Microsoft Edge のような音声認識対応ブラウザでアクセスしてください。';
    document.getElementById('status').className = "error";
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = lang;
  recognition.interimResults = true;
  recognition.continuous = true;

  recognition.onsoundstart = function() {
    document.getElementById('status').innerHTML = "認識中...";
    document.getElementById('status').className = "processing";
  };
  recognition.onnomatch = function() {
    document.getElementById('status').innerHTML = "音声を認識できませんでした";
    document.getElementById('status').className = "error";
  };
  recognition.onerror = function(event) {
    const error = event && event.error;
    if (error === 'no-speech' || error === 'aborted') {
      document.getElementById('status').innerHTML = "待機中";
      document.getElementById('status').className = "ready";
    } else {
      document.getElementById('status').innerHTML = error ? ("エラー: " + error) : "エラー";
      document.getElementById('status').className = "error";
      console.warn('Speech recognition error:', error || event);
    }
    if (flag_speech == 0) {
      restartRecognitionSoon();
    }
  };
  recognition.onsoundend = function() {
    document.getElementById('status').innerHTML = "待機中";
    document.getElementById('status').className = "ready";
  };
  recognition.onend = function() {
    recognitionActive = false;
    if (flag_speech == 0) {
      restartRecognitionSoon();
    }
  };

  recognition.onresult = function(event) {
    // 読み上げ中はマイクが読み上げ音声を拾って再認識するループを防ぐため、認識結果を破棄する
    if (tts_enabled && isTtsSpeaking()) return;

    var results = event.results;
    var current_transcripts = ''; // resultsが複数ある場合は全て連結する。
    var need_reset = false;
    for (var i = event.resultIndex; i < results.length; i++) {
      if (results[i].isFinal) {
        // 無音時などに空の確定結果が来ることがあり、「。」だけの字幕が表示・翻訳・読み上げ
        // されてしまうため、空の場合は無視する
        if (results[i][0].transcript.trim() === '') {
          flag_speech = 0;
          continue;
        }
        last_finished = results[i][0].transcript;
        const is_end_of_sentence = last_finished.endsWith('。') || last_finished.endsWith('？') || last_finished.endsWith('！');
        if (lang == 'ja-JP' && is_end_of_sentence != true) {
          last_finished += '。';
        }

        var result_log = last_finished

        if (document.getElementById('checkbox_timestamp').checked) {
          // タイムスタンプ機能
          var now = new window.Date();
          var Year = now.getFullYear();
          var Month = (("0" + (now.getMonth() + 1)).slice(-2));
          var Date = ("0" + now.getDate()).slice(-2);
          var Hour = ("0" + now.getHours()).slice(-2);
          var Min = ("0" + now.getMinutes()).slice(-2);
          var Sec = ("0" + now.getSeconds()).slice(-2);

          var timestamp = Year + '-' + Month + '-' + Date + ' ' + Hour + ':' + Min + ':' + Sec + '&#009;'
          result_log = timestamp + result_log
        }

        document.getElementById('result_log').insertAdjacentHTML('beforeend', result_log + '\n');
        textAreaHeightSet(document.getElementById('result_log'));
        tts_last_spoken = ''; // 新しい確定文が来たので、同じ文の連続でも読み上げられるようにリセット
        need_reset = true;
        setTimeoutForClearText();
        flag_speech = 0;
      } else {
        current_transcripts += results[i][0].transcript;
        clearTimeoutForClearText();
        flag_speech = 1;
      }
    }

    var displayText = [last_finished, current_transcripts].join('<br>');
    document.getElementById('result_text').innerHTML = displayText;
    // 翻訳前の原文を記録する（TTS側で「まだ翻訳されていない＝原文のまま」を判定するため）
    tts_original_text = (last_finished || '').trim();
    // 翻訳はGoogleウィジェットが動的字幕を訳さなくなったため、自前で翻訳して表示する
    scheduleSubtitleTranslation(last_finished, current_transcripts);
    setTimeoutForClearText();

    if (need_reset) { vr_function(); }
  }

  flag_speech = 0;
  document.getElementById('status').innerHTML = "待機中";
  document.getElementById('status').className = "ready";
  try {
    recognition.start();
    recognitionActive = true;
  } catch (e) {
    recognitionActive = false;
    console.warn('Speech recognition start failed:', e);
    restartRecognitionSoon(1000);
  }
}

function updateTextClearSecond() {
  const sec = Number(document.getElementById('select_autoclear_text').value);
  if ((!isNaN(sec)) && isFinite(sec) && (sec >= 0)) {
    textUpdateTimeoutSecond = sec;
  }
}

function clearTimeoutForClearText() {
  if (textUpdateTimeoutID !== 0) {
    clearTimeout(textUpdateTimeoutID);
    textUpdateTimeoutID = 0;
  }
}

// 変数 textUpdateTimeoutSecond に基づいてタイマーを設定する。
// タイマーの時間切れで、字幕を自動的に消去する。
// 変数の値がゼロ以下の場合はタイマーは設定されない。
// タイマーが既に動いている場合、処理タイミングは後からのもので上書きする。
function setTimeoutForClearText() {
  if (textUpdateTimeoutSecond <= 0) return;

  clearTimeoutForClearText();
  textUpdateTimeoutID = setTimeout(
    () => {
      document.getElementById('result_text').innerHTML = "";
      document.getElementById('result_text_en').innerHTML = "";
      last_finished = '';
      textUpdateTimeoutID = 0;
    },
    textUpdateTimeoutSecond * 1000);
}

// 認識結果のログのtextareaを自動変形する
// 参考: https://webparts.cman.jp/input/textarea/
function textAreaHeightSet(argObj) {
  // 一旦テキストエリアを小さくしてスクロールバー（縦の長さを取得）
  argObj.style.height = "10px";
  var wSclollHeight = parseInt(argObj.scrollHeight);
  // 1行の長さを取得する
  var wLineH = parseInt(argObj.style.lineHeight.replace(/px/, ''));
  // 最低2行の表示エリアにする
  if (wSclollHeight < (wLineH * 2)) {
    wSclollHeight = (wLineH * 2);
  }
  // テキストエリアの高さを設定する
  argObj.style.height = wSclollHeight + "px";
}

// 認識を手動で止める（文を区切る）
document.addEventListener('keydown',
  event => {
    if (event.key === 'Enter') {
      if (flag_speech == 1) {
        recognition.stop();
      }
    }
  });

// 認識結果のログをダウンロードする
// 参考: https://qiita.com/kerupani129/items/99fd7a768538fcd33420
function downloadLogFile() {
  const a = document.createElement('a');
  a.href = 'data:text/plain,' + encodeURIComponent(document.getElementById('result_log').value);

  var now = new window.Date();
  var Year = now.getFullYear();
  var Month = (("0" + (now.getMonth() + 1)).slice(-2));
  var Date = ("0" + now.getDate()).slice(-2);
  var Hour = ("0" + now.getHours()).slice(-2);
  var Min = ("0" + now.getMinutes()).slice(-2);
  var Sec = ("0" + now.getSeconds()).slice(-2);

  a.download = 'log_' + Year + Month + Date + '_' + Hour + Min + Sec + '.txt';

  a.click();
}

// 参考: https://blog.katsubemakito.net/html5/fullscreen
/**
 * フルスクリーン開始/終了時のイベント設定
 *
 * @param {function} callback
 */
function eventFullScreen(callback) {
  document.addEventListener("fullscreenchange", callback, false);
  document.addEventListener("webkitfullscreenchange", callback, false);
  document.addEventListener("mozfullscreenchange", callback, false);
  document.addEventListener("MSFullscreenChange", callback, false);
}

/**
 * フルスクリーンが利用できるか
 *
 * @return {boolean}
 */
function enabledFullScreen() {
  return (
    document.fullscreenEnabled || document.mozFullScreenEnabled || document.documentElement.webkitRequestFullScreen || document.msFullscreenEnabled
  );
}

/**
 * フルスクリーンにする
 *
 * @param {object} [element]
 */
function goFullScreen(element = null) {

  const doc = window.document;
  const docEl = (element === null) ? doc.documentElement : element;
  let requestFullScreen = docEl.requestFullscreen || docEl.mozRequestFullScreen || docEl.webkitRequestFullScreen || docEl.msRequestFullscreen;
  requestFullScreen.call(docEl);
}

/**
 * フルスクリーンをやめる
 */
function cancelFullScreen() {
  const doc = window.document;
  const cancelFullScreen = doc.exitFullscreen || doc.mozCancelFullScreen || doc.webkitExitFullscreen || doc.msExitFullscreen;
  cancelFullScreen.call(doc);
}

/**
 * フルスクリーン中のオブジェクトを返却
 */
function getFullScreenObject() {
  const doc = window.document;
  const objFullScreen = doc.fullscreenElement || doc.mozFullScreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement;
  return (objFullScreen);
}

const FullScreenBtn = document.querySelector("#FullScreenBtn"); // フルスクリーン化ボタン

const objResultText = document.querySelector("#result_text_container");
var font_size_windowed = parseFloat(getComputedStyle(objResultText).getPropertyValue('font-size'));
var flag_font_size_styled = 0;

window.onload = () => {
  vr_function();
  const video_doc = document.querySelector("#video_wrapper"); // フルスクリーンにするオブジェクト

  //--------------------------------
  // [event] 開始ボタンをクリック
  //--------------------------------
  FullScreenBtn.addEventListener("click", () => {
    if (getFullScreenObject()) {
      // フルスクリーンを解除
      cancelFullScreen(video_doc);
    } else {
      // フルスクリーンを開始
      if (!enabledFullScreen()) {
        alert("フルスクリーンに対応していません");
        return (false);
      }
      goFullScreen(video_doc);

    }
  });

  //--------------------------------
  // フルスクリーンイベント
  //--------------------------------
  eventFullScreen(() => {
    // ボタンを入れ替える
    if (getFullScreenObject()) {
      // フルスクリーン時に文字と画面の比率を維持
      const ratio = window.parent.screen.height / document.querySelector("#video_wrapper").clientHeight
      font_size_windowed = parseFloat(getComputedStyle(objResultText).getPropertyValue('font-size'));
      if (objResultText.style.fontSize) {
        // スライダーでフォントサイズの指定がされているかどうかを記録
        flag_font_size_styled = 1;
        font_size_windowed = parseFloat(getComputedStyle(objResultText).fontSize);
      }
      document.querySelector('#result_text_container').style.fontSize = parseFloat(getComputedStyle(objResultText).getPropertyValue('font-size')) * ratio + 'px';
      console.log("フルスクリーン開始");

    } else {
      // フルスクリーン時から通常画面に戻るときに文字と画面の比率を維持
      if (flag_font_size_styled) {
        document.querySelector('#result_text_container').style.fontSize = document.querySelector("#value_font_size").textContent + 'px';
      } else {
        // スライダーでフォントサイズの指定がされていなかった（デフォルトだった）場合は単にstyleのfontSizeを削除する
        // 分割表示時のデフォルトCSSを活かすため
        document.querySelector('#result_text_container').style.fontSize = '';
      }
      console.log("フルスクリーン終了");

    }
  });

  initConfig();
};


// 言語切替
// 参考: https://www.google.com/intl/ja/chrome/demos/speech.html
var langs = [
  ['Japanese', ['ja-JP']],
  ['English', ['en-US', 'United States'],
    ['en-AU', 'Australia'],
    ['en-CA', 'Canada'],
    ['en-IN', 'India'],
    ['en-KE', 'Kenya'],
    ['en-TZ', 'Tanzania'],
    ['en-GH', 'Ghana'],
    ['en-NZ', 'New Zealand'],
    ['en-NG', 'Nigeria'],
    ['en-ZA', 'South Africa'],
    ['en-PH', 'Philippines'],
    ['en-GB', 'United Kingdom'],
  ],
  ['Afrikaans', ['af-ZA']],
  ['አማርኛ', ['am-ET']],
  ['Azərbaycanca', ['az-AZ']],
  ['বাংলা', ['bn-BD', 'বাংলাদেশ'],
    ['bn-IN', 'ভারত']
  ],
  ['Bahasa Indonesia', ['id-ID']],
  ['Bahasa Melayu', ['ms-MY']],
  ['Català', ['ca-ES']],
  ['Čeština', ['cs-CZ']],
  ['Dansk', ['da-DK']],
  ['Deutsch', ['de-DE']],
  ['Español', ['es-AR', 'Argentina'],
    ['es-BO', 'Bolivia'],
    ['es-CL', 'Chile'],
    ['es-CO', 'Colombia'],
    ['es-CR', 'Costa Rica'],
    ['es-EC', 'Ecuador'],
    ['es-SV', 'El Salvador'],
    ['es-ES', 'España'],
    ['es-US', 'Estados Unidos'],
    ['es-GT', 'Guatemala'],
    ['es-HN', 'Honduras'],
    ['es-MX', 'México'],
    ['es-NI', 'Nicaragua'],
    ['es-PA', 'Panamá'],
    ['es-PY', 'Paraguay'],
    ['es-PE', 'Perú'],
    ['es-PR', 'Puerto Rico'],
    ['es-DO', 'República Dominicana'],
    ['es-UY', 'Uruguay'],
    ['es-VE', 'Venezuela']
  ],
  ['Euskara', ['eu-ES']],
  ['Filipino', ['fil-PH']],
  ['Français', ['fr-FR']],
  ['Basa Jawa', ['jv-ID']],
  ['Galego', ['gl-ES']],
  ['ગુજરાતી', ['gu-IN']],
  ['Hrvatski', ['hr-HR']],
  ['IsiZulu', ['zu-ZA']],
  ['Íslenska', ['is-IS']],
  ['Italiano', ['it-IT', 'Italia'],
    ['it-CH', 'Svizzera']
  ],
  ['ಕನ್ನಡ', ['kn-IN']],
  ['ភាសាខ្មែរ', ['km-KH']],
  ['Latviešu', ['lv-LV']],
  ['Lietuvių', ['lt-LT']],
  ['മലയാളം', ['ml-IN']],
  ['मराठी', ['mr-IN']],
  ['Magyar', ['hu-HU']],
  ['ລາວ', ['lo-LA']],
  ['Nederlands', ['nl-NL']],
  ['नेपाली भाषा', ['ne-NP']],
  ['Norsk bokmål', ['nb-NO']],
  ['Polski', ['pl-PL']],
  ['Português', ['pt-BR', 'Brasil'],
    ['pt-PT', 'Portugal']
  ],
  ['Română', ['ro-RO']],
  ['සිංහල', ['si-LK']],
  ['Slovenščina', ['sl-SI']],
  ['Basa Sunda', ['su-ID']],
  ['Slovenčina', ['sk-SK']],
  ['Suomi', ['fi-FI']],
  ['Svenska', ['sv-SE']],
  ['Kiswahili', ['sw-TZ', 'Tanzania'],
    ['sw-KE', 'Kenya']
  ],
  ['ქართული', ['ka-GE']],
  ['Հայերեն', ['hy-AM']],
  ['தமிழ்', ['ta-IN', 'இந்தியா'],
    ['ta-SG', 'சிங்கப்பூர்'],
    ['ta-LK', 'இலங்கை'],
    ['ta-MY', 'மலேசியா']
  ],
  ['తెలుగు', ['te-IN']],
  ['Tiếng Việt', ['vi-VN']],
  ['Türkçe', ['tr-TR']],
  ['اُردُو', ['ur-PK', 'پاکستان'],
    ['ur-IN', 'بھارت']
  ],
  ['Ελληνικά', ['el-GR']],
  ['български', ['bg-BG']],
  ['Pусский', ['ru-RU']],
  ['Српски', ['sr-RS']],
  ['Українська', ['uk-UA']],
  ['한국어', ['ko-KR']],
  ['中文', ['cmn-Hans-CN', '普通话 (中国大陆)'],
    ['cmn-Hans-HK', '普通话 (香港)'],
    ['cmn-Hant-TW', '中文 (台灣)'],
    ['yue-Hant-HK', '粵語 (香港)']
  ],
  ['हिन्दी', ['hi-IN']],
  ['ภาษาไทย', ['th-TH']]
];

for (var i = 0; i < langs.length; i++) {
  select_language.options[i] = new Option(langs[i][0], i);
}

// デフォルトの言語を設定
select_language.selectedIndex = 0;
updateCountry();
select_dialect.selectedIndex = 0;

function updateCountry() {
  for (var i = select_dialect.options.length - 1; i >= 0; i--) {
    select_dialect.remove(i);
  }
  var list = langs[select_language.selectedIndex];
  for (var i = 1; i < list.length; i++) {
    select_dialect.options.add(new Option(list[i][1], list[i][0]));
  }
  select_dialect.style.display = list[1].length == 1 ? 'none' : 'inline';
  updateLanguage()
}

function updateLanguage() {
  var flag_recognition_stopped = 0;
  if (recognition) {
    recognition.stop();
    flag_recognition_stopped = 1;
  }
  lang = select_dialect.value;
  if (flag_recognition_stopped) {
    vr_function();
  }
}

// 結果の翻訳機能を追加
// 参考: https://pisuke-code.com/js-usage-of-google-trans-api/
function googleTranslateElementInit() {
  new google.translate.TranslateElement({
    pageLanguage: 'ja',
    includedLanguages: 'en,ko,ru,fr,zh-TW,id',
    layout: google.translate.TranslateElement.InlineLayout.SIMPLE
  }, 'google_translate_element');

  // デフォルトで英語翻訳を自動選択
  setTimeout(function() {
    var select = document.querySelector('.goog-te-combo');
    if (select) {
      select.value = 'en';
      select.dispatchEvent(new Event('change'));
    }
    updateTtsVoiceList();
  }, 1000);
}

// 翻訳読み上げ（TTS）機能
// Google翻訳ウィジェットが #result_text_en のDOMを書き換えたタイミングを
// MutationObserverで検知し、翻訳後のテキストを speechSynthesis で読み上げる。
var tts_enabled = false;    // 読み上げのON/OFF
var tts_last_spoken = '';   // 直前に読み上げたテキスト（同じ文を繰り返し読まないため）
var tts_original_text = ''; // 翻訳前の原文（原文のまま＝翻訳未完了の判定に使う）
var tts_voices = [];        // 翻訳先言語に合う音声のリスト

function updateTtsEnabled(checkbox) {
  tts_enabled = checkbox.checked;
  if (!tts_enabled) {
    speechSynthesis.cancel();
  }
}

// 現在の翻訳先言語を取得する
// ウィジェットの言語メニューはiframe内に生成されchangeイベントが取れないため、
// コンボボックス → ウィジェットが設定する googtrans クッキー の順で調べる
function getTranslationTargetLang() {
  const combo = document.querySelector('.goog-te-combo');
  if (combo && combo.value) return combo.value;
  const match = document.cookie.match(/googtrans=\/[^\/;]*\/([^;]+)/);
  if (match) return decodeURIComponent(match[1]);
  return 'en';
}

// ---- 自前翻訳 ----
// Google翻訳ウィジェット（新方式）は、後から追加された字幕を自動翻訳しなくなったため、
// 確定/暫定の認識テキストを翻訳エンドポイントで自前翻訳し、#result_text_en に表示する。
// ウィジェットは翻訳先言語の選択UIとしてのみ使う（getTranslationTargetLangで取得）。
var translationDebounceTimer = 0;
var translationSeq = 0; // 古いレスポンスが新しい表示を上書きしないための通し番号

// 認識テキスト（確定＋暫定）の翻訳をデバウンスして実行する
function scheduleSubtitleTranslation(finalText, interimText) {
  const target = getTranslationTargetLang();
  const source = (lang || '').split('-')[0].toLowerCase();
  const elEn = document.getElementById('result_text_en');
  // 翻訳先が未選択、または原文と同じ言語なら翻訳せず原文をそのまま表示する
  if (!target || target.toLowerCase().split('-')[0] === source) {
    elEn.innerHTML = [finalText, interimText].join('<br>');
    return;
  }
  if (translationDebounceTimer) clearTimeout(translationDebounceTimer);
  translationDebounceTimer = setTimeout(function() {
    translationDebounceTimer = 0;
    translateSubtitle(finalText, interimText, source, target);
  }, 300);
}

async function translateSubtitle(finalText, interimText, source, target) {
  const seq = ++translationSeq;
  const lines = [];
  for (const t of [finalText, interimText]) {
    const trimmed = (t || '').trim();
    if (!trimmed) { lines.push(''); continue; }
    try {
      lines.push(await translateText(trimmed, source, target));
    } catch (e) {
      console.warn('翻訳に失敗しました:', e);
      lines.push(trimmed); // 失敗時は原文を表示
    }
  }
  if (seq !== translationSeq) return; // より新しい翻訳が走っているので破棄する
  document.getElementById('result_text_en').innerHTML = lines.join('<br>');
}

// 無料の翻訳エンドポイント（APIキー不要・CORS許可あり）で1文を翻訳する
async function translateText(text, sl, tl) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx'
    + '&sl=' + encodeURIComponent(sl || 'auto')
    + '&tl=' + encodeURIComponent(tl)
    + '&dt=t&q=' + encodeURIComponent(text);
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  // data[0] は翻訳セグメントの配列。各 seg[0]（訳文）を連結する
  return (data[0] || []).map(seg => seg[0]).join('');
}

// 翻訳先言語に合う音声だけを「声」セレクタに反映する
function updateTtsVoiceList() {
  const select = document.getElementById('select_tts_voice');
  const target = getTranslationTargetLang();
  const target_prefix = target.toLowerCase().split('-')[0];
  tts_voices = speechSynthesis.getVoices().filter(
    v => v.lang.toLowerCase().replace('_', '-').split('-')[0] === target_prefix
  );
  select.innerHTML = '';
  for (var i = 0; i < tts_voices.length; i++) {
    select.options[i] = new Option(tts_voices[i].name, i);
  }
  // この言語で以前選んだ声が保存されていれば選択を復元する
  const saved_name = (config.tts_voice || {})[target];
  if (saved_name) {
    for (var j = 0; j < tts_voices.length; j++) {
      if (tts_voices[j].name === saved_name) {
        select.value = String(j);
        break;
      }
    }
  }
}

// 選んだ声を翻訳先言語ごとに保存する（言語を切り替えても選択が維持されるように）
document.getElementById('select_tts_voice').addEventListener('change', function() {
  const voice = tts_voices[Number(this.value)];
  if (voice) {
    updateConfigClass('tts_voice', getTranslationTargetLang(), voice.name);
  }
});

// 音声リストは非同期に読み込まれるため、読み込み完了時にもセレクタを更新する
if ('speechSynthesis' in window) {
  speechSynthesis.onvoiceschanged = updateTtsVoiceList;
}

// 翻訳先言語の切り替えを監視し、声リストを連動させる
// （言語メニューはiframe内にありイベントで検知できないため、ポーリングで監視する）
var tts_current_target = '';
setInterval(function() {
  const target = getTranslationTargetLang();
  if (target !== tts_current_target) {
    tts_current_target = target;
    speechSynthesis.cancel(); // 言語が変わったので読み上げ中・待機中のものは打ち切る
    tts_last_spoken = '';
    updateTtsVoiceList();
  }
}, 3000);

// 読み上げ中（または読み上げ待ち）かどうか
function isTtsSpeaking() {
  return ('speechSynthesis' in window) && (speechSynthesis.speaking || speechSynthesis.pending);
}

// 要素内の最初の<br>までのテキストを取得する（確定済みの1文目だけを読み上げ対象にするため）
function getFirstLineText(el) {
  var text = '';
  for (var i = 0; i < el.childNodes.length; i++) {
    if (el.childNodes[i].nodeName === 'BR') break;
    text += el.childNodes[i].textContent;
  }
  return text.trim();
}

function speakTranslation(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = getTranslationTargetLang();
  const voice = tts_voices[Number(document.getElementById('select_tts_voice').value)];
  if (voice) {
    utterance.voice = voice;
  }
  utterance.rate = Number(document.getElementById('select_tts_rate').value) || 1;
  speechSynthesis.speak(utterance);
}

// 翻訳結果のDOM書き換えを監視して読み上げる
new MutationObserver(function() {
  if (!tts_enabled) return;
  // Gemini Live 翻訳が有効な間は、その音声出力と二重に読み上げないようブラウザTTSを止める
  if (typeof gemini_live_active !== 'undefined' && gemini_live_active) return;
  const text = getFirstLineText(document.getElementById('result_text_en'));
  if (text === '') return;                  // 自動クリア等で空になった
  if (!/[\p{L}\p{N}]/u.test(text)) return;  // 句読点や記号だけのテキストは読み上げない
  if (text === tts_original_text) return;   // まだ翻訳されていない（原文のまま）
  if (text === tts_last_spoken) return;     // 読み上げ済み
  tts_last_spoken = text;
  speakTranslation(text);
}).observe(document.getElementById('result_text_en'), { childList: true, subtree: true, characterData: true });

// フォント切替
// 参考: https://www.google.com/intl/ja/chrome/demos/speech.html
var fonts_custom = [
  ['Noto Sans JP', "'Noto Sans JP', sans-serif", '500'],
  ['BIZ UDPゴシック', "'BIZ UDPゴシック', 'BIZ UDPGothic', 'Noto Sans JP', sans-serif", '700'],
  ['BIZ UDP明朝', "'BIZ UDP明朝', 'BIZ UDPMincho', 'Noto Sans JP', serif", '400'],
  ['游ゴシック', "游ゴシック体, 'Yu Gothic', YuGothic, sans-serif", 'bold'],
  ['メイリオ', "'メイリオ', 'Meiryo', 'Noto Sans JP', sans-serif", 'bold'],
  ['ポップ体（Windows）', "'HGS創英角ﾎﾟｯﾌﾟ体', 'Noto Sans JP', sans-serif", 'bold'],
  ['ゴシック体（ブラウザ標準）', "sans-serif", 'normal'],
  ['明朝体（ブラウザ標準）', "serif", 'normal']
];

for (var i = 0; i < fonts_custom.length; i++) {
  select_font.options[i] = new Option(fonts_custom[i][0], i);
}

// デフォルトの言語を設定
select_font.selectedIndex = 0;

function initConfig() {
  function triggerEvent(type, elem) {
    const ev = document.createEvent('HTMLEvents');
    ev.initEvent(type, true, true);
    elem.dispatchEvent(ev);
  }
  ['slider_font_size',
    'slider_opacity',
    'slider_text_shadow_stroke',
    'slider_text_stroke',
    'slider_line_height',
    'slider_letter_spacing',
    'selector_text_color',
    'selector_text_shadow_color',
    'selector_text_stroke_color',
    'slider_text_bg_opacity',
    'selector_text_bg_color',
    'selector_video_bg',
  ].forEach(id => {
    if (typeof config[id] !== 'undefined') {
      const el = document.getElementById(id);
      el.value = config[id];
      triggerEvent('input', el);
    }
  });
  ['video_bg',
    'text_overlay_wrapper',
    'FullScreenBtn',
    'appearance_wrapper'
  ].forEach(id => {
    if (typeof config[id] !== 'undefined') {
      const el = document.getElementById(id);
      if (config[id]) {
        Object.keys(config[id]).forEach(key => {
          if (config[id][key]) {
            el.classList.add(key);
          } else {
            el.classList.remove(key);
          }
        });
      }
    }
  });
  
  ['checkbox_controls',
    'checkbox_log',
    'checkbox_timestamp',
    'checkbox_tts'
  ].forEach(id => {
    const el = document.getElementById(id);
    if(el){
      if (typeof config[id] !== 'undefined') {
        el.checked = config[el.id];
        triggerEvent('input', el);
      }
      el.addEventListener('input', function (e) {
        updateConfig(e.target.id, e.target.checked);
      });
    }
  });

  if (typeof config.position !== 'undefined') {
    const el = document.getElementById(config.position);
    el.checked = 'checked';
    triggerEvent('input', el);
  }
  if (typeof config.select_font !== 'undefined') {
    select_font.selectedIndex = config.select_font;
    triggerEvent('change', select_font);
  }
  if (typeof config.select_autoclear_text !== 'undefined') {
    const el = document.getElementById('select_autoclear_text');
    selectValueIfExists(el, config.select_autoclear_text);
    triggerEvent('change', el);
  }
  if (typeof config.select_tts_rate !== 'undefined') {
    const el = document.getElementById('select_tts_rate');
    selectValueIfExists(el, config.select_tts_rate);
    triggerEvent('change', el);
  }

  document.querySelectorAll('input.control_input').forEach(
    el => el.addEventListener('input', updateConfigValue)
  );
  document.querySelectorAll('input[name="selector_position"]').forEach(
    el => el.addEventListener('input', ev => updateConfig('position', el.id))
  );
  document.querySelector('#select_font').addEventListener('change', updateConfigValue);

  document.querySelector('#select_autoclear_text').addEventListener('change', updateConfigValue);
  document.querySelector('#select_tts_rate').addEventListener('change', updateConfigValue);
}

var _configSaveTimer = 0;
function _saveConfig() {
  if (_configSaveTimer) clearTimeout(_configSaveTimer);
  _configSaveTimer = setTimeout(function() {
    _configSaveTimer = 0;
    localStorage.speech_to_text_config = JSON.stringify(config);
  }, 300);
}

function updateConfig(key, value) {
  config[key] = value;
  _saveConfig();
}

function updateConfigClass(key, value_key, value) {
  if (config[key] == undefined) {
    config[key] = {};
  }
  config[key][value_key] = value;
  _saveConfig();
}

function toggleClass(id, className) {
  const el = document.getElementById(id);
  const value = el.classList.toggle(className);
  updateConfigClass(id, className, value);
}

function updateConfigValue() {
  updateConfig(this.id, this.value);
}

function deleteConfig() {
  localStorage.removeItem('speech_to_text_config');
  location.reload();
}
