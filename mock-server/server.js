const express = require('express');
const cors = require('cors');
const { getDrivers, getStatus, clockIn, clockOut, alcoholCheck } = require('./routes/attendance');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// GASのdoPostと同じ形式でリクエストを受け付けるエンドポイント
app.post('/mock-gas', (req, res) => {
  const { action, ...params } = req.body;

  console.log(`[${new Date().toLocaleString('ja-JP')}] action=${action}`, params);

  let result;
  switch (action) {
    case 'getDrivers':
      result = getDrivers();
      break;
    case 'getStatus':
      result = getStatus(params);
      break;
    case 'clockIn':
      result = clockIn(params);
      break;
    case 'clockOut':
      result = clockOut(params);
      break;
    case 'alcoholCheck':
      result = alcoholCheck(params);
      break;
    default:
      result = { success: false, error: `未知のaction: ${action}` };
  }

  res.json(result);
});

// サーバー死活確認用
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'モックサーバー稼働中' });
});

app.listen(PORT, () => {
  console.log(`モックサーバー起動中: http://localhost:${PORT}`);
  console.log(`エンドポイント: POST http://localhost:${PORT}/mock-gas`);
});
