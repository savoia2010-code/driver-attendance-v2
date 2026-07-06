// ローカル開発用：index.html をHTTPで配信する簡易サーバー
// （file:// では動作確認しづらいブラウザ機能・自動テスト用）
const express = require('express');
const path    = require('path');

const app  = express();
const PORT = 8080;

app.use(express.static(path.join(__dirname, '..')));

app.listen(PORT, () => {
  console.log(`静的サーバー起動中: http://localhost:${PORT}/index.html`);
});
