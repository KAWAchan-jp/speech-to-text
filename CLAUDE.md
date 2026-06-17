# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

Web Speech API を使ったリアルタイム音声認識字幕ページ。ビデオ会議・配信・プレゼン向け。  
GitHub Pages でホスティング: https://kawachan-jp.github.io/speech-to-text/

## ビルド・実行

ビルドステップなし。バニラ HTML/CSS/JS のみ。

```bash
# ローカルで動かす（Web Speech API はローカルファイルでも動くが、HTTP サーバーが安定）
python -m http.server 8000
# または
npx http-server
```

**推奨ブラウザ**: Google Chrome または Microsoft Edge（Windows/macOS）  
Safari・モバイルブラウザは Web Speech API の制限により非推奨。

## アーキテクチャ

### ファイル構成

| ファイル | 役割 |
|---------|------|
| `index.html` | UI シェル。DOM 構造・設定パネル・字幕エリアを定義 |
| `main.js` | **コアロジック**（938行）。音声認識・翻訳・TTS・設定管理をすべて担う |
| `style.css` | スタイリング（582行） |
| `gemini-live-translate.js` | Gemini Live API による音声→音声翻訳（実験的、545行） |
| `gemini-live-translate.config.js` | Gemini API キー設定（`.gitignore` 対象・コミット禁止） |
| `gemini-live-translate.config.example.js` | 上記のテンプレート |
| `kuromoji/` | 日本語形態素解析ライブラリ（ひらがな変換に使用） |

### main.js の主要モジュール

- **音声認識**: `vr_function()` が `webkitSpeechRecognition` を起動し、途切れた場合に自動再起動
- **字幕表示**: `textAreaHeightSet()` でリサイズ、`#result_text` / `#result_text_en` に描画
- **Google Translate**: `googleTranslateElementInit()` でウィジェット初期化（API キー不要）
- **TTS 読み上げ**: `speakTranslation()` が `speechSynthesis` を使用、読み上げ中は認識を一時停止（ハウリング防止）
- **ひらがな変換**: `resultToHiragana()` が kuromoji.js を使用
- **設定の永続化**: 全設定を `localStorage` に JSON 保存（`initConfig` / `updateConfig`）
- **ログ出力**: `downloadLogFile()` でタイムスタンプ付きテキストをダウンロード

### Gemini Live 統合（実験的）

- WebSocket ベース、16kHz PCM16 入力・24kHz 再生
- 接続管理は `gemini-live-translate.js` が担当
- `main.js` から `GeminiLiveTranslate` クラスを呼び出す
- 指数バックオフで自動再接続

## バージョン管理

バージョンは `index.html` 内の `<meta name="version">` と表示テキストで管理。  
形式: 3桁（例: `1.1.0`）。通常は**3桁目のみインクリメント**。

## 注意事項

- `gemini-live-translate.config.js` は `.gitignore` に含まれている。**絶対にコミットしない**
- 外部ライブラリへの依存は kuromoji.js のみ（npm なし）
- Google Translate ウィジェットは CDN から動的ロード
- コードコメント・ドキュメントは**日本語**で統一
