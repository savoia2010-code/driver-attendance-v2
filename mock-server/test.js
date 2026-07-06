// 自動テスト：モックサーバーが起動している状態で実行する
// テスト前に全データファイルを初期状態にリセットする

const fs   = require('fs');
const path = require('path');

// ── テスト前にデータファイルをリセット ──
// （リセットしないと前回テストが追加した D099 / テスト確認者 が残り、件数チェックが失敗する）
const BASE_DRIVERS = [
  { id: 'D001', name: '田中 太郎', url_token: 'tanaka-taro' },
  { id: 'D002', name: '佐藤 次郎', url_token: 'sato-jiro' },
  { id: 'D003', name: '鈴木 三郎', url_token: 'suzuki-saburo' },
  { id: 'D004', name: '高橋 四郎', url_token: 'takahashi-shiro' },
  { id: 'D005', name: '伊藤 五郎', url_token: 'ito-goro' },
];
const BASE_CHECKERS = [
  { id: 'C001', name: '山田 一郎' },
  { id: 'C002', name: '中村 花子' },
  { id: 'C003', name: '小林 二郎' },
];
fs.writeFileSync(path.join(__dirname, 'data/records.json'), '[]', 'utf8');
fs.writeFileSync(path.join(__dirname, 'data/drivers.json'),  JSON.stringify(BASE_DRIVERS, null, 2), 'utf8');
fs.writeFileSync(path.join(__dirname, 'data/checkers.json'), JSON.stringify(BASE_CHECKERS, null, 2), 'utf8');
console.log('データファイルをリセットしました\n');

const BASE_URL = 'http://localhost:3000/mock-gas';
const today    = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })).toISOString().split('T')[0];

// ── 認可用の資格情報（GAS と同一ルール） ──
const ADMIN   = { adminKey: 'admin123' };          // 管理者
const AS_D1   = { driverToken: 'tanaka-taro' };    // D001 本人
const AS_D2   = { driverToken: 'sato-jiro' };      // D002 本人（他人アクセスのテスト用）

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
  const newChecker = await post('saveChecker', { name: 'テスト確認者', ...AS_D1 });
  assert('成功する', newChecker.success === true);
  const afterAdd = await post('getCheckers');
  assert('確認者が1名増える', afterAdd.checkers.length === 4);

  // ──────────────────────────────────────────
  // [6] saveChecker（重複）
  // ──────────────────────────────────────────
  console.log('\n[6] saveChecker（重複）');
  const dupChecker = await post('saveChecker', { name: 'テスト確認者', ...AS_D1 });
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
  const statusBefore = await post('getStatus', { driverId, ...AS_D1 });
  assert('成功する', statusBefore.success === true);
  assert('status が none', statusBefore.status === 'none');

  // ──────────────────────────────────────────
  // [10] clockIn
  // ──────────────────────────────────────────
  console.log('\n[10] clockIn');
  const clockInRes = await post('clockIn', { driverId, ...AS_D1 });
  assert('成功する', clockInRes.success === true);
  assert('status が working', clockInRes.record.status === 'working');
  assert('日付が today', clockInRes.record.date === today);

  // ──────────────────────────────────────────
  // [11] clockIn 二重打刻の拒否
  // ──────────────────────────────────────────
  console.log('\n[11] clockIn（二重打刻）');
  const dupClockIn = await post('clockIn', { driverId, ...AS_D1 });
  assert('エラーになる', dupClockIn.success === false);

  // ──────────────────────────────────────────
  // [12] getStatus（出勤後）
  // ──────────────────────────────────────────
  console.log('\n[12] getStatus（出勤後）');
  const statusWorking = await post('getStatus', { driverId, ...AS_D1 });
  assert('status が working', statusWorking.status === 'working');

  // ──────────────────────────────────────────
  // [13] alcoholCheck（正常値 0.00）
  // ──────────────────────────────────────────
  console.log('\n[13] alcoholCheck（正常値）');
  const alcPass = await post('alcoholCheck', { driverId, value: 0, ...AS_D1 });
  assert('成功する', alcPass.success === true);
  assert('result が pass', alcPass.result === 'pass');

  // ──────────────────────────────────────────
  // [14] alcoholCheck（検知値あり）
  // ──────────────────────────────────────────
  console.log('\n[14] alcoholCheck（検知値あり）');
  const alcFail = await post('alcoholCheck', { driverId, value: 0.15, ...AS_D1 });
  assert('成功する', alcFail.success === true);
  assert('result が fail', alcFail.result === 'fail');

  // ──────────────────────────────────────────
  // [15] alcoholCheck（非数値）
  // ──────────────────────────────────────────
  console.log('\n[15] alcoholCheck（非数値入力）');
  const alcInvalid = await post('alcoholCheck', { driverId, value: 'abc', ...AS_D1 });
  assert('エラーになる', alcInvalid.success === false);

  // ──────────────────────────────────────────
  // [16] clockOut
  // ──────────────────────────────────────────
  console.log('\n[16] clockOut');
  const clockOutRes = await post('clockOut', { driverId, ...AS_D1 });
  assert('成功する', clockOutRes.success === true);
  assert('status が done', clockOutRes.record.status === 'done');

  // ──────────────────────────────────────────
  // [17] getStatus（退勤後）
  // ──────────────────────────────────────────
  console.log('\n[17] getStatus（退勤後）');
  const statusDone = await post('getStatus', { driverId, ...AS_D1 });
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
    ...AS_D1,
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
    ...AS_D1,
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
  const allRecords = await post('getRecords', { driverId, ...AS_D1 });
  assert('成功する', allRecords.success === true);
  assert('2件返る（today + yesterday）', allRecords.records.length === 2);

  // ──────────────────────────────────────────
  // [21] getRecords（期間フィルタ）
  // ──────────────────────────────────────────
  console.log('\n[21] getRecords（期間フィルタ）');
  const rangeRecords = await post('getRecords', { driverId, from: today, to: today, ...AS_D1 });
  assert('成功する', rangeRecords.success === true);
  assert('today の1件だけ返る', rangeRecords.records.length === 1);
  assert('取得した記録の日付が today', rangeRecords.records[0].date === today);

  // ──────────────────────────────────────────
  // [22] getRecentRecords
  // ──────────────────────────────────────────
  console.log('\n[22] getRecentRecords');
  const recentRes = await post('getRecentRecords', { driverId, limit: 1, ...AS_D1 });
  assert('成功する', recentRes.success === true);
  assert('limit=1 なので1件', recentRes.records.length === 1);
  assert('最新の today が先頭', recentRes.records[0].date === today);

  // ──────────────────────────────────────────
  // [23] deleteRecord
  // ──────────────────────────────────────────
  console.log('\n[23] deleteRecord');
  const delRes = await post('deleteRecord', { driverId, date: yesterday, ...AS_D1 });
  assert('成功する', delRes.success === true);
  const afterDel = await post('getRecords', { driverId, ...AS_D1 });
  assert('1件に減る', afterDel.records.length === 1);

  // ──────────────────────────────────────────
  // [24] deleteRecord（存在しない）
  // ──────────────────────────────────────────
  console.log('\n[24] deleteRecord（存在しない）');
  const delNg = await post('deleteRecord', { driverId, date: '2000-01-01', ...AS_D1 });
  assert('エラーになる', delNg.success === false);

  // ──────────────────────────────────────────
  // [25] saveDriver（新規追加）
  // ──────────────────────────────────────────
  console.log('\n[25] saveDriver（新規追加）');
  const addDriver = await post('saveDriver', { id: 'D099', name: 'テスト ドライバー', ...ADMIN });
  assert('成功する', addDriver.success === true);
  assert('url_token が自動生成される（32文字）', addDriver.driver && addDriver.driver.url_token.length === 32);
  const d6 = await post('getDrivers');
  assert('6名になる', d6.drivers.length === 6);

  // ──────────────────────────────────────────
  // [26] saveDriver（名前更新）
  // ──────────────────────────────────────────
  console.log('\n[26] saveDriver（名前更新）');
  const updDriver = await post('saveDriver', { id: 'D099', name: 'テスト 更新済み', ...ADMIN });
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

  // ──────────────────────────────────────────
  // [28] saveRecord の savedAt 付与
  // ──────────────────────────────────────────
  console.log('\n[28] saveRecord の savedAt 付与');
  const cRecA = await post('saveRecord', { driverId, date: today, destination: '競合テストA', ...AS_D1 });
  assert('成功する', cRecA.success === true);
  assert('レスポンスに record.savedAt が含まれる', cRecA.record && !!cRecA.record.savedAt);
  assert('baseSavedAt は保存されない', cRecA.record && !('baseSavedAt' in cRecA.record));

  // ──────────────────────────────────────────
  // [29] savedAt による競合検知
  // ──────────────────────────────────────────
  console.log('\n[29] savedAt による競合検知');
  const stale = await post('saveRecord', { driverId, date: today, destination: '競合テストB', baseSavedAt: '2000-01-01T00:00:00.000Z', ...AS_D1 });
  assert('古い baseSavedAt は conflict エラーになる', stale.success === false && stale.error === 'conflict');
  assert('latest に最新レコードが返る', stale.latest && stale.latest.destination === '競合テストA');
  const match = await post('saveRecord', { driverId, date: today, destination: '競合テストC', baseSavedAt: cRecA.record.savedAt, ...AS_D1 });
  assert('一致する baseSavedAt は保存できる', match.success === true);
  const force = await post('saveRecord', { driverId, date: today, destination: '競合テストD', ...AS_D1 });
  assert('baseSavedAt 無しは従来どおり上書きできる', force.success === true);
  const forceEmpty = await post('saveRecord', { driverId, date: today, destination: '競合テストE', baseSavedAt: '', ...AS_D1 });
  assert('baseSavedAt 空文字も上書きできる', forceEmpty.success === true);

  // ──────────────────────────────────────────
  // [30] 連続保存でもレコードは1件のまま
  // ──────────────────────────────────────────
  console.log('\n[30] 連続保存でもレコードは1件のまま');
  const afterConflict = await post('getRecords', { driverId, from: today, to: today, ...AS_D1 });
  assert('同一 driverId+date のレコードは1件', afterConflict.records.length === 1);
  assert('最後の保存内容が反映されている', afterConflict.records[0].destination === '競合テストE');
  const delDouble = await post('deleteRecord', { driverId, date: today, ...AS_D1 });
  assert('削除が成功する', delDouble.success === true);
  const delAgain = await post('deleteRecord', { driverId, date: today, ...AS_D1 });
  assert('二重削除は2回目がエラーになる（データ不整合なし）', delAgain.success === false);

  // ──────────────────────────────────────────
  // [31] 認可：認証なし・他人のトークンは拒否
  // ──────────────────────────────────────────
  console.log('\n[31] 認可（未認証・他人トークンの拒否）');
  const noAuthRead = await post('getRecords', { driverId });
  assert('認証なしの記録取得は forbidden', noAuthRead.success === false && noAuthRead.error === 'forbidden');
  const crossRead = await post('getRecords', { driverId, ...AS_D2 });
  assert('他人のトークンでの記録取得は forbidden', crossRead.success === false && crossRead.error === 'forbidden');
  const noAuthWrite = await post('saveRecord', { driverId, date: today, destination: '不正書き込み' });
  assert('認証なしの記録保存は forbidden', noAuthWrite.success === false && noAuthWrite.error === 'forbidden');
  const crossDelete = await post('deleteRecord', { driverId, date: today, ...AS_D2 });
  assert('他人のトークンでの削除は forbidden', crossDelete.success === false && crossDelete.error === 'forbidden');
  const noAuthDriver = await post('saveDriver', { id: 'D777', name: '不正追加' });
  assert('認証なしのドライバー追加は forbidden', noAuthDriver.success === false && noAuthDriver.error === 'forbidden');
  const driverAddsDriver = await post('saveDriver', { id: 'D778', name: '不正追加2', ...AS_D1 });
  assert('ドライバー権限でのドライバー追加は forbidden', driverAddsDriver.success === false && driverAddsDriver.error === 'forbidden');
  const noAuthChecker = await post('saveChecker', { name: '不正確認者' });
  assert('認証なしの確認者追加は forbidden', noAuthChecker.success === false && noAuthChecker.error === 'forbidden');

  // ──────────────────────────────────────────
  // [32] 認可：トークン秘匿と管理者アクセス
  // ──────────────────────────────────────────
  console.log('\n[32] 認可（トークン秘匿・管理者）');
  const initPublic = await post('getInit');
  assert('非管理者の getInit に url_token が含まれない',
    initPublic.drivers.every(d => !('url_token' in d)));
  const initAdmin = await post('getInit', { ...ADMIN });
  assert('管理者の getInit には url_token が含まれる',
    initAdmin.drivers.every(d => 'url_token' in d));
  const adminRead = await post('getRecords', { driverId, ...ADMIN });
  assert('管理者は任意のドライバーの記録を取得できる', adminRead.success === true);

  // ──────────────────────────────────────────
  // [33] verifyDriverToken と専用URL再発行
  // ──────────────────────────────────────────
  console.log('\n[33] verifyDriverToken・トークン再発行');
  const vtOk = await post('verifyDriverToken', { ...AS_D1 });
  assert('正しいトークンで本人情報が返る', vtOk.success === true && vtOk.driver.id === 'D001');
  const vtNg = await post('verifyDriverToken', { driverToken: 'wrong-token' });
  assert('誤ったトークンは拒否される', vtNg.success === false);
  const vtEmpty = await post('verifyDriverToken', {});
  assert('トークンなしは拒否される', vtEmpty.success === false);
  const regen = await post('regenerateDriverToken', { id: 'D001', ...ADMIN });
  assert('管理者はトークンを再発行できる', regen.success === true && regen.driver.url_token.length === 32);
  assert('再発行でトークンが変わる', regen.driver.url_token !== AS_D1.driverToken);
  const oldTokenRead = await post('getRecords', { driverId, ...AS_D1 });
  assert('旧トークンは無効になる', oldTokenRead.success === false && oldTokenRead.error === 'forbidden');
  const newTokenRead = await post('getRecords', { driverId, driverToken: regen.driver.url_token });
  assert('新トークンで記録を取得できる', newTokenRead.success === true);
  const regenNoAuth = await post('regenerateDriverToken', { id: 'D001' });
  assert('認証なしの再発行は forbidden', regenNoAuth.success === false && regenNoAuth.error === 'forbidden');

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
