# プロジェクト共通ルール

## 作業ルール
- 大きな変更の前に必ず git commit でセーブポイントを作る
- コミットメッセージは日本語で何をしたか分かるように書く
- 作業完了後も git commit する
- 複数ファイルにまたがる変更は必ず事前にユーザーへ説明する

## セキュリティ原則

### 機密情報のハードコード禁止
以下の値をソースコードに直接書いてはいけない：
- GASデプロイURL（https://script.google.com/macros/s/...）
- Google SheetsのスプレッドシートID
- APIキー・トークン類
- パスワード・認証情報

これらは必ず config.js（または config.gs）に分離し、.gitignore に追加すること。

### config.js のテンプレートを必ず用意する
機密情報を分離した場合、代わりに config.example.js を作成してリポジトリに含める。

### .gitignore の確認・更新
コード変更時、以下が .gitignore に含まれているか必ず確認する：
- .env
- .env.*
- config.js
- config.gs
- *.key
- *.pem
含まれていない場合は追加する。

### 既存コードのセキュリティ弱点を見つけたら報告する
作業中に以下を発見した場合、修正前に必ずユーザーに報告すること：
- ハードコードされた機密情報
- console.log に個人情報や機密値が出力されている
- 認証なしで誰でも書き込めるGASのdoPost

### GASのdoPost/doGetには最低限の認証チェックを入れる
アクセストークンはスクリプトプロパティから取得する。

## このプロジェクトの技術スタック
- フロントエンド：HTML単一ファイル + バニラJS
- バックエンド：Google Apps Script（GAS）
- DB：Google Sheets
- デプロイ：GitHub Pages
- ローカル開発：Claude Code（Windows環境）
