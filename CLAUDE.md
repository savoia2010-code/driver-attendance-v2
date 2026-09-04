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

これらは必ず config.js（または config.gs）に分離すること。

### config.js の位置づけ（重要・公開リポジトリ）
本リポジトリはパブリック公開かつ GitHub Pages で配信するため、**config.js は追跡対象**であり、
その中身（GAS_URL・APP_TOKEN）は誰でも閲覧できる。したがって config.js は
「秘密の置き場」ではなく「公開設定ファイル」として扱う。真に秘密の値は入れないこと。

実際の認可は次の2つが担う（どちらもリポジトリには存在しない）：
- ドライバー個人トークン `url_token` … スプレッドシート上にのみ存在。専用URLで個別配布
- 管理者キー `ADMIN_KEY` … GASのスクリプトプロパティにのみ存在

SPREADSHEET_ID・ADMIN_KEY・ACCESS_TOKEN の実値は GAS のスクリプトプロパティに置き、
リポジトリのどのファイルにも書かない。

### config.example.js を必ず維持する
設定項目を追加・変更したら config.example.js も同時に更新する。

### .gitignore の確認・更新
コード変更時、以下が .gitignore に含まれているか必ず確認する：
- .env
- .env.*
- config.gs
- *.key
- *.pem
含まれていない場合は追加する。
※ config.js は上記の理由により意図的に追跡している（除外し直さないこと）。

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
