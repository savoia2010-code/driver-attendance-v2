const fs = require('fs');
const path = require('path');

const driversPath  = path.join(__dirname, '../data/drivers.json');
const recordsPath  = path.join(__dirname, '../data/records.json');
const checkersPath = path.join(__dirname, '../data/checkers.json');

// ── データ読み書きヘルパー ──
function loadDrivers()    { return JSON.parse(fs.readFileSync(driversPath,  'utf8')); }
function saveDrivers(d)   { fs.writeFileSync(driversPath,  JSON.stringify(d, null, 2), 'utf8'); }
function loadRecords()    { return JSON.parse(fs.readFileSync(recordsPath,  'utf8')); }
function saveRecords(r)   { fs.writeFileSync(recordsPath,  JSON.stringify(r, null, 2), 'utf8'); }
function loadCheckers()   { return JSON.parse(fs.readFileSync(checkersPath, 'utf8')); }
function saveCheckers(c)  { fs.writeFileSync(checkersPath, JSON.stringify(c, null, 2), 'utf8'); }

// ── 日時ヘルパー（JST） ──
function nowJST() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}
// 今日の日付を YYYY-MM-DD 形式で返す
function todayISO() {
  const jst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  return jst.toISOString().split('T')[0];
}

// ── モック認証定数（テスト用固定値） ──
const MOCK_PASSWORD  = '1234';
const MOCK_ADMIN_KEY = 'admin123';

// ============================================================
// 認証
// ============================================================

function verifyPassword({ password }) {
  if (!password) return { success: false, error: 'password が必要です' };
  return { success: password === MOCK_PASSWORD };
}

function verifyAdminKey({ key }) {
  if (!key) return { success: false, error: 'key が必要です' };
  return { success: key === MOCK_ADMIN_KEY };
}

// ============================================================
// ドライバー
// ============================================================

function getDrivers() {
  return { success: true, drivers: loadDrivers() };
}

function saveDriver({ id, name }) {
  if (!id || !name) return { success: false, error: 'id と name が必要です' };
  const drivers = loadDrivers();
  const idx = drivers.findIndex(d => d.id === id);
  if (idx >= 0) {
    drivers[idx].name = name;
    saveDrivers(drivers);
    return { success: true, message: 'ドライバーを更新しました' };
  }
  drivers.push({ id, name, url_token: id.toLowerCase() });
  saveDrivers(drivers);
  return { success: true, message: 'ドライバーを追加しました' };
}

// ============================================================
// 確認者
// ============================================================

function getCheckers() {
  return { success: true, checkers: loadCheckers() };
}

function saveChecker({ name }) {
  if (!name) return { success: false, error: 'name が必要です' };
  const checkers = loadCheckers();
  if (checkers.find(c => c.name === name)) {
    return { success: true, message: '既に登録済みです' };
  }
  const id = 'C' + String(checkers.length + 1).padStart(3, '0');
  checkers.push({ id, name });
  saveCheckers(checkers);
  return { success: true, message: '確認者を追加しました' };
}

// ============================================================
// 初期化（ドライバー＋確認者を1リクエストで返す）
// ============================================================

function getInit() {
  return {
    success:  true,
    drivers:  loadDrivers(),
    checkers: loadCheckers()
  };
}

// ============================================================
// 打刻
// ============================================================

function getStatus({ driverId }) {
  if (!driverId) return { success: false, error: 'driverId が必要です' };
  const driver = loadDrivers().find(d => d.id === driverId);
  if (!driver) return { success: false, error: 'ドライバーが見つかりません' };

  const today  = todayISO();
  const record = loadRecords().find(r => r.driverId === driverId && r.date === today) || null;
  return {
    success:    true,
    driverName: driver.name,
    date:       today,
    status:     record ? record.status : 'none',
    record
  };
}

function clockIn({ driverId }) {
  if (!driverId) return { success: false, error: 'driverId が必要です' };
  const driver = loadDrivers().find(d => d.id === driverId);
  if (!driver) return { success: false, error: 'ドライバーが見つかりません' };

  const records = loadRecords();
  const today   = todayISO();
  if (records.find(r => r.driverId === driverId && r.date === today && r.clockIn)) {
    return { success: false, error: '本日はすでに出勤打刻済みです' };
  }

  const newRecord = {
    id: `${driverId}-${Date.now()}`,
    driverId,
    driverName: driver.name,
    date:       today,
    clockIn:    nowJST(),
    clockOut:   null,
    alcoholCheck: null,
    status: 'working'
  };
  records.push(newRecord);
  saveRecords(records);
  return { success: true, message: '出勤打刻しました', record: newRecord };
}

function clockOut({ driverId }) {
  if (!driverId) return { success: false, error: 'driverId が必要です' };
  const records = loadRecords();
  const today   = todayISO();
  const idx     = records.findIndex(r => r.driverId === driverId && r.date === today && r.status === 'working');
  if (idx === -1) return { success: false, error: '出勤中の記録が見つかりません' };

  records[idx].clockOut = nowJST();
  records[idx].status   = 'done';
  saveRecords(records);
  return { success: true, message: '退勤打刻しました', record: records[idx] };
}

function alcoholCheck({ driverId, value }) {
  if (!driverId) return { success: false, error: 'driverId が必要です' };
  if (value === undefined || value === null || value === '') {
    return { success: false, error: 'アルコール値（value）が必要です' };
  }
  const numValue = parseFloat(value);
  if (isNaN(numValue)) return { success: false, error: 'アルコール値は数値で入力してください' };

  const records = loadRecords();
  const today   = todayISO();
  const idx     = records.findIndex(r => r.driverId === driverId && r.date === today);
  if (idx === -1) return { success: false, error: '本日の打刻記録が見つかりません' };

  records[idx].alcoholCheck = { value: numValue, time: nowJST(), result: numValue === 0 ? 'pass' : 'fail' };
  saveRecords(records);
  return { success: true, message: 'アルコールチェックを記録しました', value: numValue, result: numValue === 0 ? 'pass' : 'fail' };
}

// ============================================================
// 日報レコード（フル保存・取得・削除）
// ============================================================

// 日報データを保存（driverId + date で upsert）
function saveRecord(data) {
  const { driverId, date } = data;
  if (!driverId || !date) return { success: false, error: 'driverId と date が必要です' };
  const dateStr = String(date).slice(0, 10); // YYYY-MM-DD に正規化

  const records = loadRecords();
  const idx     = records.findIndex(r => r.driverId === driverId && r.date === dateStr);
  const record  = { ...data, date: dateStr, savedAt: nowJST() };

  if (idx >= 0) {
    records[idx] = { ...records[idx], ...record };
  } else {
    records.push(record);
  }
  saveRecords(records);
  return { success: true, message: '記録を保存しました', record };
}

// 記録削除
function deleteRecord({ driverId, date }) {
  if (!driverId || !date) return { success: false, error: 'driverId と date が必要です' };
  const dateStr = String(date).slice(0, 10);
  const records = loadRecords();
  const idx     = records.findIndex(r => r.driverId === driverId && r.date === dateStr);
  if (idx === -1) return { success: false, error: '削除対象の記録が見つかりません' };

  records.splice(idx, 1);
  saveRecords(records);
  return { success: true, message: '記録を削除しました' };
}

// 期間指定で記録取得（from・to は YYYY-MM-DD、省略可）
function getRecords({ driverId, from, to }) {
  if (!driverId) return { success: false, error: 'driverId が必要です' };
  let filtered = loadRecords().filter(r => r.driverId === driverId);
  if (from) filtered = filtered.filter(r => r.date >= from);
  if (to)   filtered = filtered.filter(r => r.date <= to);
  filtered.sort((a, b) => a.date.localeCompare(b.date));
  return { success: true, records: filtered };
}

// 直近N件取得
function getRecentRecords({ driverId, limit }) {
  if (!driverId) return { success: false, error: 'driverId が必要です' };
  const filtered = loadRecords()
    .filter(r => r.driverId === driverId)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, Number(limit) || 10);
  return { success: true, records: filtered };
}

module.exports = {
  verifyPassword, verifyAdminKey,
  getDrivers, saveDriver,
  getCheckers, saveChecker, getInit,
  getStatus, clockIn, clockOut, alcoholCheck,
  saveRecord, deleteRecord, getRecords, getRecentRecords
};
