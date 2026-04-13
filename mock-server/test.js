// 自動テスト：モックサーバーが起動している状態で実行する
// テスト前に records.json を自動リセットする

const fs   = require('fs');
const path = require('path');

// ── テスト前にrecords.jsonをリセット ──
const recordsPath = path.join(__dirname, 'data/records.json');
fs.writeFileSync(recordsPath, '[]', 'utf8');
console.log('records.json をリセットしました\n');

const BASE_URL = 'http://localhost:3000/mock-gas';
const today    = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })).toISOString().split('T')[0];

async function post(action, params = {}) {
  const res = await fetch(BASE_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action, ...params })
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

  // ──────────────────────────────────────────
  // [1] ヘルスチェック
  // ──────────────────────────────────────────
  console.log('[1] ヘルスチェック');
  const health = await fetch('http://localhost:3000/health').then(r => r.json());
  assert('サーバーが起動している', health.status === 'ok');

  // ──────────────────────────────────────────
  // [2] getInit（ドライバー＋確認者を一括取得）
  // ──────────────────────────────────────────
  console.log('\n[2] getInit');
  const init = await post('getInit');
  assert('成功する', init.success === true);
  assert('drivers が配列', Array.isArray(init.drivers));
  assert('checkers が配列', Array.isArray(init.checkers));
  assert('5名のドライバーが返る', init.drivers.length === 5);
  assert('3名の確認者が返る', init.checkers.length === 3);

  // ──────────────────────────────────────────
  // [3] getDrivers
  // ──────────────────────────────────────────
  console.log('\n[3] getDrivers');
  const driversRes = await post('getDrivers');
  assert('成功する', driversRes.success === true);
  assert('5名返ってくる', driversRes.drivers.length === 5);

  const driverId   = driversRes.drivers[0].id;   // D001
  const driverName = driversRes.drivers[0].name;

  // ──────────────────────────────────────────
  // [4] getCheckers
  // ──────────────────────────────────────────
  console.log('\n[4] getCheckers');
  const checkersRes = await post('getCheckers');
  assert('成功する', checkersRes.success === true);
  assert('3名の確認者が返る', checkersRes.checkers.length === 3);

  // ──────────────────────────────────────────
  // [5] saveChecker（新規追加）
  // ──────────────────────────────────────────
  console.log('\n[5] saveChecker（新規追加）');
  const newChecker = await post('saveChecker', { name: 'テスト確認者' });
  assert('成功する', newChecker.success === true);
  const afterAdd = await post('getCheckers');
  assert('確認者が1名増える', afterAdd.checkers.length === 4);

  // ──────────────────────────────────────────
  // [6] saveChecker（重複）
  // ──────────────────────────────────────────
  console.log('\n[6] saveChecker（重複）');
  const dupChecker = await post('saveChecker', { name: 'テスト確認者' });
  assert('成功する（重複は無視）', dupChecker.success === true);
  const afterDup = await post('getCheckers');
  assert('人数が増えない', afterDup.checkers.length === 4);

  // ──────────────────────────────────────────
  // [7] verifyPassword
  // ──────────────────────────────────────────
  console.log('\n[7] verifyPassword');
  const pwOk  = await post('verifyPassword', { password: '1234' });
  const pwNg  = await post('verifyPassword', { password: 'wrong' });
  assert('正しいパスワードは成功', pwOk.success === true);
  assert('誤ったパスワードは失敗', pwNg.success === false);

  // ──────────────────────────────────────────
  // [8] verifyAdminKey
  // ──────────────────────────────────────────
  console.log('\n[8] verifyAdminKey');
  const keyOk = await post('verifyAdminKey', { key: 'admin123' });
  const keyNg = await post('verifyAdminKey', { key: 'wrong' });
  assert('正しいキーは成功', keyOk.success === true);
  assert('誤ったキーは失敗', keyNg.success === false);

  // ──────────────────────────────────────────
  // [9] getStatus（打刻前）
  // ──────────────────────────────────────────
  console.log('\n[9] getStatus（打刻前）');
  const statusBefore = await post('getStatus', { driverId });
  assert('成功する', statusBefore.success === true);
  assert('status が none', statusBefore.status === 'none');

  // ──────────────────────────────────────────
  // [10] clockIn
  // ──────────────────────────────────────────
  console.log('\n[10] clockIn');
  const clockInRes = await post('clockIn', { driverId });
  assert('成功する', clockInRes.success === true);
  assert('status が working', clockInRes.record.status === 'working');
  assert('日付が today', clockInRes.record.date === today);

  // ──────────────────────────────────────────
  // [11] clockIn 二重打刻の拒否
  // ──────────────────────────────────────────
  console.log('\n[11] clockIn（二重打刻）');
  const dupClockIn = await post('clockIn', { driverId });
  assert('エラーになる', dupClockIn.success === false);

  // ──────────────────────────────────────────
  // [12] getStatus（出勤後）
  // ──────────────────────────────────────────
  console.log('\n[12] getStatus（出勤後）');
  const statusWorking = await post('getStatus', { driverId });
  assert('status が working', statusWorking.status === 'working');

  // ──────────────────────────────────────────
  // [13] alcoholCheck（正常値 0.00）
  // ──────────────────────────────────────────
  console.log('\n[13] alcoholCheck（正常値）');
  const alcPass = await post('alcoholCheck', { driverId, value: 0 });
  assert('成功する', alcPass.success === true);
  assert('result が pass', alcPass.result === 'pass');

  // ──────────────────────────────────────────
  // [14] alcoholCheck（検知値あり）
  // ──────────────────────────────────────────
  console.log('\n[14] alcoholCheck（検知値あり）');
  const alcFail = await post('alcoholCheck', { driverId, value: 0.15 });
  assert('成功する', alcFail.success === true);
  assert('result が fail', alcFail.result === 'fail');

  // ──────────────────────────────────────────
  // [15] alcoholCheck（非数値）
  // ──────────────────────────────────────────
  console.log('\n[15] alcoholCheck（非数値入力）');
  const alcInvalid = await post('alcoholCheck', { driverId, value: 'abc' });
  assert('エラーになる', alcInvalid.success === false);

  // ──────────────────────────────────────────
  // [16] clockOut
  // ──────────────────────────────────────────
  console.log('\n[16] clockOut');
  const clockOutRes = await post('clockOut', { driverId });
  assert('成功する', clockOutRes.success === true);
  assert('status が done', clockOutRes.record.status === 'done');

  // ──────────────────────────────────────────
  // [17] getStatus（退勤後）
  // ──────────────────────────────────────────
  console.log('\n[17] getStatus（退勤後）');
  const statusDone = await post('getStatus', { driverId });
  assert('status が done', statusDone.status === 'done');

  // ──────────────────────────────────────────
  // [18] saveRecord（日報フル保存）
  // ──────────────────────────────────────────
  console.log('\n[18] saveRecord（新規保存）');
  const yesterday = (() => {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  })();
  const saveRes = await post('saveRecord', {
    driverId,
    driverName,
    date:        yesterday,
    destination: '東京',
    distance:    150,
    clockIn:     '08:00',
    clockOut:    '17:00',
    status:      'done'
  });
  assert('成功する', saveRes.success === true);
  assert('date が正規化される', saveRes.record.date === yesterday);

  // ──────────────────────────────────────────
  // [19] saveRecord（上書き更新）
  // ──────────────────────────────────────────
  console.log('\n[19] saveRecord（上書き更新）');
  const updateRes = await post('saveRecord', {
    driverId,
    driverName,
    date:        yesterday,
    destination: '大阪',
    distance:    300
  });
  assert('成功する', updateRes.success === true);
  assert('destination が更新される', updateRes.record.destination === '大阪');

  // ──────────────────────────────────────────
  // [20] getRecords（全件取得）
  // ──────────────────────────────────────────
  console.log('\n[20] getRecords（全件）');
  const allRecords = await post('getRecords', { driverId });
  assert('成功する', allRecords.success === true);
  assert('2件返る（today + yesterday）', allRecords.records.length === 2);

  // ──────────────────────────────────────────
  // [21] getRecords（期間フィルタ）
  // ──────────────────────────────────────────
  console.log('\n[21] getRecords（期間フィルタ）');
  const rangeRecords = await post('getRecords', { driverId, from: today, to: today });
  assert('成功する', rangeRecords.success === true);
  assert('today の1件だけ返る', rangeRecords.records.length === 1);
  assert('取得した記録の日付が today', rangeRecords.records[0].date === today);

  // ──────────────────────────────────────────
  // [22] getRecentRecords
  // ──────────────────────────────────────────
  console.log('\n[22] getRecentRecords');
  const recentRes = await post('getRecentRecords', { driverId, limit: 1 });
  assert('成功する', recentRes.success === true);
  assert('limit=1 なので1件', recentRes.records.length === 1);
  assert('最新の today が先頭', recentRes.records[0].date === today);

  // ──────────────────────────────────────────
  // [23] deleteRecord
  // ──────────────────────────────────────────
  console.log('\n[23] deleteRecord');
  const delRes = await post('deleteRecord', { driverId, date: yesterday });
  assert('成功する', delRes.success === true);
  const afterDel = await post('getRecords', { driverId });
  assert('1件に減る', afterDel.records.length === 1);

  // ──────────────────────────────────────────
  // [24] deleteRecord（存在しない）
  // ──────────────────────────────────────────
  console.log('\n[24] deleteRecord（存在しない）');
  const delNg = await post('deleteRecord', { driverId, date: '2000-01-01' });
  assert('エラーになる', delNg.success === false);

  // ──────────────────────────────────────────
  // [25] saveDriver（新規追加）
  // ──────────────────────────────────────────
  console.log('\n[25] saveDriver（新規追加）');
  const addDriver = await post('saveDriver', { id: 'D099', name: 'テスト ドライバー' });
  assert('成功する', addDriver.success === true);
  const d6 = await post('getDrivers');
  assert('6名になる', d6.drivers.length === 6);

  // ──────────────────────────────────────────
  // [26] saveDriver（名前更新）
  // ──────────────────────────────────────────
  console.log('\n[26] saveDriver（名前更新）');
  const updDriver = await post('saveDriver', { id: 'D099', name: 'テスト 更新済み' });
  assert('成功する', updDriver.success === true);
  const d6after = await post('getDrivers');
  const d099 = d6after.drivers.find(d => d.id === 'D099');
  assert('名前が更新されている', d099 && d099.name === 'テスト 更新済み');

  // ──────────────────────────────────────────
  // [27] 未知のaction
  // ──────────────────────────────────────────
  console.log('\n[27] 未知のaction');
  const unknown = await post('unknownAction');
  assert('エラーになる', unknown.success === false);

  // ── 結果サマリー ──
  console.log(`\n${'='.repeat(40)}`);
  console.log(`結果: ${passed} 件成功 / ${failed} 件失敗`);
  if (failed === 0) console.log('✅ 全テスト通過');
  console.log('='.repeat(40));
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('\nテスト実行エラー:', err.message);
  console.error('モックサーバーが起動しているか確認してください（npm start）');
  process.exit(1);
});
