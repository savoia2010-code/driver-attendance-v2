const express = require('express');
const cors    = require('cors');
const {
  verifyPassword, verifyAdminKey,
  getDrivers, saveDriver,
  getCheckers, saveChecker, getInit,
  getStatus, clockIn, clockOut, alcoholCheck,
  saveRecord, deleteRecord, getRecords, getRecentRecords
} = require('./routes/attendance');

const app  = express();
const PORT = 3000;

app.use(cors());
// 実GASと同様に text/plain で届くJSONボディも受け付ける
// （フロントはCORSプリフライト回避のため text/plain で送信する）
app.use(express.json({ type: () => true }));

// action → handler のマッピング
const ACTION_MAP = {
  verifyPassword, verifyAdminKey,
  getDrivers, saveDriver,
  getCheckers, saveChecker, getInit,
  getStatus, clockIn, clockOut, alcoholCheck,
  saveRecord, deleteRecord, getRecords, getRecentRecords
};

// GASのdoPostと同じ形式でリクエストを受け付けるエンドポイント
app.post('/mock-gas', (req, res) => {
  // token は認証用フィールド（モックでは検証せず、データに混入しないよう除去のみ）
  const { action, token, ...params } = req.body;
  console.log(`[${new Date().toLocaleString('ja-JP')}] action=${action}`);

  const handler = ACTION_MAP[action];
  if (!handler) {
    return res.json({ success: false, error: `未知のaction: ${action}` });
  }
  res.json(handler(params));
});

// サーバー死活確認用
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'モックサーバー稼働中' });
});

app.listen(PORT, () => {
  console.log(`モックサーバー起動中: http://localhost:${PORT}`);
  console.log(`エンドポイント: POST http://localhost:${PORT}/mock-gas`);
  console.log(`対応action: ${Object.keys(ACTION_MAP).join(', ')}`);
});
