# 音声認識リアルタイム字幕 Webページ

Web Speech API を使用した音声認識の結果をブラウザ上にリアルタイム表示するWebページです。  
ビデオ会議・生配信・プレゼンなど様々な場面で字幕として活用できます。

# デモページ
https://kawachan-jp.github.io/speech-to-text/  
*PC版のGoogle ChromeまたはMicrosoft Edgeでアクセスしてください。*

---

# 機能一覧

## 音声認識
- Web Speech API によるリアルタイム音声認識
- 多言語対応（日本語・英語・中国語・韓国語など多数）
- 認識が途切れた場合は自動で再開
- 日本語認識時、文末に「。」を自動付与
- Enterキーで手動で文を区切る

## 翻訳
- Google Translate による英語翻訳（ページ読み込み時に自動で英語翻訳をオン）

## ひらがな変換
- 日本語認識時のみ表示されるオプション
- kuromoji.js による形態素解析でひらがな表示

## 表示スタイルの調整
- フォントサイズ・透明度・行間・字間
- 文字色・影（サイズ・色）・フチ（サイズ・色）
- フォント選択（Noto Sans JP / BIZ UDPゴシック / BIZ UDP明朝 / 游ゴシック / メイリオ など）
- 文字位置（全体・左・右・上・下）
- 文字の表示/非表示・左右反転

## 文字背景
- 背景の塗り（濃さ・色）
- 単色背景（表示/非表示・色指定）※クロマキー合成用途に活用可

## フルスクリーン
- フルスクリーンボタンのワンクリックで全画面表示
- フルスクリーン時に文字サイズを画面比率に合わせて自動調整

## 認識ログ
- 確定した認識結果のログ表示
- タイムスタンプ記録オプション
- テキストの編集・コピー
- ログのテキストファイルダウンロード

## その他
- 設定はブラウザの localStorage に自動保存・復元
- PWA対応（Service Worker によるオフライン動作）

---

# 動作環境

- **PC版 Google Chrome**（推奨）
  - Windows / macOS / Linux で動作確認済み
- **PC版 Microsoft Edge**
  - Windows / macOS で動作確認済み
- **macOS版 Safari**
  - 動作するものの挙動が不安定なため非推奨
- **Android版 Google Chrome**
  - 音声認識が適切に動作しない場合あり
- **iPhone / iPad**
  - iOS の Chrome・Safari は Web Speech API 非対応のため使用不可

---

# よくある質問

## 音声データ・文字起こしデータの扱いについて
- 開発者のサーバー（kawachan-jp.github.io）では、音声および文字データの保存は行っておりません。
- 「ログをダウンロード」でダウンロードされるファイルは、アクセスしているユーザーのブラウザで生成されています。
- 音声文字変換には Web Speech API を利用しており、音声データの処理方法はユーザーが利用するブラウザに依存します。
  - 参考: [Web Speech APIを使う - MDN](https://developer.mozilla.org/ja/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API)
  - 参考: [Google Chrome Privacy Whitepaper](https://www.google.com/chrome/privacy/whitepaper.html)
  - 参考: [Microsoft Edge プライバシー ホワイトペーパー](https://learn.microsoft.com/ja-jp/microsoft-edge/privacy-whitepaper/#speech-recognition)
- 開発者は、本プログラムおよびそのホスティングページを使用したことにより生じた損害等の一切の責任を負いかねます。

## マイクが認識されない
- ページを再読み込みするか、ブラウザの設定を確認してください。  
  参考: https://support.google.com/chrome/answer/2693767?co=GENIE.Platform%3DDesktop&hl=ja&oco=1

## 相手側の音声を表示したい
- マイクに相手の声が物理的に入るようにするか、PC内部で音声をブラウザに流し込む方法があります。

## 文字の修正をしたい
- 認識結果のログ欄では直接テキストの編集が可能です。
- リアルタイム表示中の編集は非対応です。

---

# 外部ライブラリ

## kuromoji.js
- https://github.com/takuyaa/kuromoji.js
- 形態素解析ライブラリ（ひらがな変換に使用）
- License: Apache License 2.0

---

# 参考資料
- [Web Speech API Demonstration](https://www.google.com/intl/ja/chrome/demos/speech.html)
- [Web Speech APIで途切れない音声認識](https://jellyware.jp/kurage/iot/webspeechapi.html)
- [使用しているブラウザを判定したい](https://qiita.com/sakuraya/items/33f93e19438d0694a91d)
- [HTML5 フルスクリーンの開始と解除](https://blog.katsubemakito.net/html5/fullscreen)
- [テキストエリアの高さを自動にする](https://webparts.cman.jp/input/textarea/)
- [JavaScriptでファイル保存・開くダイアログを出して読み書き](https://qiita.com/kerupani129/99fd7a768538fcd33420)
- [JavaScriptからGoogle翻訳を使えるAPI](https://pisuke-code.com/js-usage-of-google-trans-api/)

---

# 謝辞

本プログラムは [1heisuzuki/speech-to-text-webcam-overlay](https://github.com/1heisuzuki/speech-to-text-webcam-overlay) をベースに、カメラ機能の削除・翻訳の英語固定・デフォルト英語翻訳の自動選択などの変更を加えたものです。
