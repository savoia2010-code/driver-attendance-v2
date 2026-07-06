const express = require('express');
const cors    = require('cors');
const { dispatch, ACTIONS } = require('./routes/attendance');

const app  = express();
const PORT = 3000;

app.use(cors());
// 実GASと同様に text/plain で届くJSONボディも受け付ける
// （フロントはCORSプリフライト回避のため text/plain で送信する）
app.use(express.json({ type: () => true }));

// GASのdoPostと同じ形式でリクエストを受け付けるエンドポイント
// 認可（adminKey / driverToken）は dispatch 内で GAS と同一ルールで検証する
app.post('/mock-gas', (req, res) => {
  const { action, token, ...params } = req.body;
  console.log(`[${new Date().toLocaleString('ja-JP')}] action=${action}`);
  res.json(dispatch(action, params));
});

// サーバー死活確認用
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'モックサーバー稼働中' });
});

app.listen(PORT, () => {
  console.log(`モックサーバー起動中: http://localhost:${PORT}`);
  console.log(`エンドポイント: POST http://localhost:${PORT}/mock-gas`);
  console.log(`対応action: ${ACTIONS.join(', ')}`);
});
