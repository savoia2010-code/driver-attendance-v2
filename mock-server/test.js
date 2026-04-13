// 自動テスト：モックサーバーが起動している状態で実行する
const BASE_URL = 'http://localhost:3000/mock-gas';

async function post(action, params = {}) {
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...params })
  });
  return res.json();
}

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

async function run() {
  console.log('=== モックサーバー 自動テスト ===\n');

  // ヘルスチェック
  console.log('[1] ヘルスチェック');
  const health = await fetch('http://localhost:3000/health').then(r => r.json());
  assert('サーバーが起動している', health.status === 'ok');

  // ドライバー一覧取得
  console.log('\n[2] getDrivers');
  const drivers = await post('getDrivers');
  assert('成功する', drivers.success === true);
  assert('5名返ってくる', drivers.drivers.length === 5);

  const driverId = drivers.drivers[0].id;

  // 状態確認（出勤前）
  console.log('\n[3] getStatus（出勤前）');
  const statusBefore = await post('getStatus', { driverId });
  assert('成功する', statusBefore.success === true);
  assert('status が none', statusBefore.status === 'none');

  // 出勤打刻
  console.log('\n[4] clockIn');
  const clockInRes = await post('clockIn', { driverId });
  assert('成功する', clockInRes.success === true);
  assert('status が working', clockInRes.record.status === 'working');

  // 二重打刻の拒否
  console.log('\n[5] clockIn 二重打刻');
  const dupClockIn = await post('clockIn', { driverId });
  assert('エラーになる', dupClockIn.success === false);

  // 状態確認（出勤後）
  console.log('\n[6] getStatus（出勤後）');
  const statusAfter = await post('getStatus', { driverId });
  assert('成功する', statusAfter.success === true);
  assert('status が working', statusAfter.status === 'working');

  // アルコールチェック
  console.log('\n[7] alcoholCheck（正常値）');
  const alcoholRes = await post('alcoholCheck', { driverId, value: 0 });
  assert('成功する', alcoholRes.success === true);
  assert('result が pass', alcoholRes.result === 'pass');

  // アルコールチェック（異常値）
  console.log('\n[8] alcoholCheck（異常値）');
  const alcoholFail = await post('alcoholCheck', { driverId, value: 0.15 });
  assert('成功する', alcoholFail.success === true);
  assert('result が fail', alcoholFail.result === 'fail');

  // アルコールチェック（非数値）
  console.log('\n[9] alcoholCheck（非数値入力）');
  const alcoholInvalid = await post('alcoholCheck', { driverId, value: 'abc' });
  assert('エラーになる', alcoholInvalid.success === false);

  // 退勤打刻
  console.log('\n[10] clockOut');
  const clockOutRes = await post('clockOut', { driverId });
  assert('成功する', clockOutRes.success === true);
  assert('status が done', clockOutRes.record.status === 'done');

  // 状態確認（退勤後）
  console.log('\n[11] getStatus（退勤後）');
  const statusDone = await post('getStatus', { driverId });
  assert('status が done', statusDone.status === 'done');

  // 未知のaction
  console.log('\n[12] 未知のaction');
  const unknown = await post('unknownAction');
  assert('エラーになる', unknown.success === false);

  // 結果サマリー
  console.log(`\n=== 結果: ${passed} 件成功 / ${failed} 件失敗 ===`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('テスト実行エラー:', err.message);
  console.error('モックサーバーが起動しているか確認してください（npm start）');
  process.exit(1);
});
