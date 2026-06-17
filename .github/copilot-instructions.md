# Copilot Instructions

Web Speech API を使ったリアルタイム字幕 Web アプリ。バニラ JS / HTML / CSS のみ（ビルドステップなし）。

## ファイル構成
- `index.html` — UI シェル
- `main.js` — 音声認識・翻訳・TTS・設定管理のコアロジック
- `style.css` — スタイリング
- `gemini-live-translate.js` — Gemini Live API 連携（実験的）

## ルール
- コメント・コミットメッセージは日本語
- バージョンは 4 桁形式、通常は 4 桁目のみインクリメント
- `gemini-live-translate.config.js` はコミット禁止（.gitignore 対象）
- 全設定は `localStorage` に保存
