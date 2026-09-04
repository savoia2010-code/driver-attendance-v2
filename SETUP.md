# 開発環境セットアップ手順（Mac）

Windows から移行した開発環境を Mac で立ち上げる手順。

## 前提：必要なソフト

| ソフト | 確認コマンド | 入手先 |
|---|---|---|
| Node.js | `node --version` | https://nodejs.org（v24系を推奨。移行元は v24.13.0） |
| Git | `git --version` | macOS標準（無ければ `xcode-select --install`） |
| Claude Code | `claude --version` | https://claude.com/claude-code |

Homebrew を使う場合：`brew install node git`

## セットアップ手順

### 1. フォルダを配置する

転送したフォルダをホーム直下などに置く（例：`~/driver-attendance-v2`）。
`.git` フォルダごとコピーされていれば、これまでのコミット履歴もそのまま残っている。

```bash
cd ~/driver-attendance-v2
git log --oneline -5   # 履歴が見えればOK
git status             # クリーンならOK
```

### 2. config.js を確認する

`config.js` はリポジトリに含まれている（GitHub Pages で配信するため）。
**コミット済みの値は本番GASを指している**ので、そのままだと本番データを読み書きする。

モックサーバーで開発する場合は、一時的に `GAS_URL` をローカルに向ける：

```js
const CONFIG = {
  GAS_URL: 'http://localhost:3000/mock-gas',
  APP_TOKEN: '',
};
```

**この変更はコミットしないこと**（本番URLに戻してから push する）。
元に戻すには `git checkout -- config.js`。

本番GASのデプロイ手順・スクリプトプロパティは `gas/README.md` を参照。

### 3. 依存パッケージをインストールする

`npm install` ではなく `npm ci` を使う（lockfile 通りに入り、移行元と同一バージョンになる）。

```bash
npm ci
```

### 4. 動作確認する

```bash
npm start   # モックサーバー起動（http://localhost:3000）
```

別のターミナルで：

```bash
npm test    # 自動テスト。「84 件成功 / 0 件失敗」ならOK
```

アプリ画面を開く場合は、さらに別のターミナルで静的サーバーを起動する：

```bash
node mock-server/static.js   # http://localhost:8080/index.html
```

### 5. 動作確認用のURL

| 用途 | URL |
|---|---|
| ドライバー（専用URL） | `http://localhost:8080/index.html?token=tanaka-taro` |
| 管理者 | `http://localhost:8080/index.html?mode=admin`（キー：`admin123`） |

※ 上記トークン・キーはモックサーバー用のテスト値。本番では使われない。

## 移行後の注意点

- **`.claude/settings.local.json` は移行されない**（OS固有設定のため git 管理外）。
  Mac で Claude Code を使ううちに自動生成されるので、そのままでよい。
  共有設定である `.claude/settings.json` と各エージェント定義は移行済み。
- **`node_modules` は移行しない**。手順3の `npm ci` で入れ直す。
- サーバーの停止は Mac では `taskkill` ではなく次を使う：
  ```bash
  pkill -f "node mock-server"
  ```

## トラブルシューティング

**`npm ci` が失敗する**
Node.js のバージョンを確認する（`node --version`）。v24系が望ましい。

**ポートが使用中（EADDRINUSE）**
```bash
lsof -i :3000    # 使用中のプロセスを確認
pkill -f "node mock-server"
```

**git status で大量の差分が出る**
改行コードの問題。`.gitattributes` で LF に統一済みのため通常は起きないが、
発生した場合は次で正規化する：
```bash
git add --renormalize .
```
