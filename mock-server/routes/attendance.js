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
// 認証・認可（GAS実装 gas/code.gs と同一仕様）
// ============================================================

function verifyPassword({ password }) {
  if (!password) return { success: false, error: 'password が必要です' };
  return { success: password === MOCK_PASSWORD };
}

// 管理者キー検証（総当たり対策：連続失敗でロックアウト）
const ADMIN_FAIL_LIMIT   = 5;
const ADMIN_LOCK_MS      = 10 * 60 * 1000;  // 10分
let _adminFails   = 0;
let _adminLockedAt = 0;

function verifyAdminKey({ key }) {
  if (!key) return { success: false, error: 'key が必要です' };
  if (_adminFails >= ADMIN_FAIL_LIMIT && Date.now() - _adminLockedAt < ADMIN_LOCK_MS) {
    return { success: false, error: '試行回数の上限に達しました。しばらく待ってから再試行してください' };
  }
  if (key === MOCK_ADMIN_KEY) {
    _adminFails = 0;
    return { success: true };
  }
  _adminFails++;
  _adminLockedAt = Date.now();
  return { success: false };
}

// リクエストの adminKey / driverToken から認可コンテキストを作る
function resolveAuth(params) {
  const auth = { isAdmin: false, driver: null };
  if (params.adminKey && params.adminKey === MOCK_ADMIN_KEY) auth.isAdmin = true;
  if (params.driverToken) {
    // トークンが空のドライバーは照合対象にしない（空文字一致の抜け穴を防ぐ）
    const d = loadDrivers().find(x => x.url_token && x.url_token === params.driverToken);
    if (d) auth.driver = d;
  }
  return auth;
}

const FORBIDDEN = { success: false, error: 'forbidden' };

// 指定ドライバーの記録への操作権限：管理者 or 本人のみ。エラー時はレスポンス、OKなら null
function guardDriver(auth, driverId) {
  if (auth.isAdmin) return null;
  if (auth.driver && driverId && auth.driver.id === driverId) return null;
  return FORBIDDEN;
}

function guardAnyAuth(auth) { return (auth.isAdmin || auth.driver) ? null : FORBIDDEN; }
function guardAdmin(auth)   { return auth.isAdmin ? null : FORBIDDEN; }

// ドライバートークンから本人情報を返す（専用URL起動時の解決用）
function verifyDriverToken(auth) {
  if (!auth.driver) return { success: false, error: 'invalid token' };
  return { success: true, driver: { id: auth.driver.id, name: auth.driver.name } };
}

// 推測不可能なトークンを生成（UUID v4 ベース・ハイフン除去で32文字）
function newToken() {
  return require('crypto').randomUUID().replace(/-/g, '');
}

// ============================================================
// ドライバー
// ============================================================

// url_token はドライバー個人の秘密。管理者以外には返さない
function stripTokens(drivers, auth) {
  return drivers.map(d => auth && auth.isAdmin
    ? { id: d.id, name: d.name, url_token: d.url_token || '' }
    : { id: d.id, name: d.name });
}

function getDrivers(params, auth) {
  return { success: true, drivers: stripTokens(loadDrivers(), auth) };
}

// 新規追加時は url_token をサーバー側で自動生成して返す（管理者のみ・dispatch でガード済み）
function saveDriver({ id, name }) {
  if (!id || !name) return { success: false, error: 'id と name が必要です' };
  const drivers = loadDrivers();
  const idx = drivers.findIndex(d => d.id === id);
  if (idx >= 0) {
    drivers[idx].name = name;
    saveDrivers(drivers);
    return { success: true, message: 'ドライバーを更新しました',
             driver: { id, name, url_token: drivers[idx].url_token || '' } };
  }
  const url_token = newToken();
  drivers.push({ id, name, url_token });
  saveDrivers(drivers);
  return { success: true, message: 'ドライバーを追加しました', driver: { id, name, url_token } };
}

// ドライバーの url_token を再発行（管理者のみ・dispatch でガード済み）
function regenerateDriverToken({ id }) {
  if (!id) return { success: false, error: 'id が必要です' };
  const drivers = loadDrivers();
  const idx = drivers.findIndex(d => d.id === id);
  if (idx === -1) return { success: false, error: '対象のドライバーが見つかりません' };
  drivers[idx].url_token = newToken();
  saveDrivers(drivers);
  return { success: true, message: '専用URLを再発行しました',
           driver: { id: drivers[idx].id, name: drivers[idx].name, url_token: drivers[idx].url_token } };
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

function getInit(params, auth) {
  return {
    success:  true,
    drivers:  stripTokens(loadDrivers(), auth),
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

  // 楽観的競合検知：クライアントが基準にした savedAt（baseSavedAt）が
  // サーバー上の savedAt と異なる場合、他の端末が先に保存している
  // （baseSavedAt が空・未指定の場合は従来どおり上書き保存）
  if (idx >= 0 && data.baseSavedAt && records[idx].savedAt &&
      data.baseSavedAt !== records[idx].savedAt) {
    return { success: false, error: 'conflict', latest: records[idx] };
  }

  // savedAt はサーバー側で付与（ミリ秒精度で一意にし、競合判定の基準にする）
  const record = { ...data, date: dateStr, savedAt: new Date().toISOString() };
  delete record.baseSavedAt;

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

// ============================================================
// ディスパッチ（GASの doPost と同一の認可ルール）
// ============================================================

const ACTIONS = [
  'verifyPassword', 'verifyAdminKey', 'verifyDriverToken',
  'getInit', 'getDrivers', 'getCheckers',
  'getRecords', 'getRecentRecords', 'saveRecord', 'deleteRecord',
  'getStatus', 'clockIn', 'clockOut', 'alcoholCheck',
  'saveChecker', 'saveDriver', 'regenerateDriverToken',
];

function dispatch(action, rawParams) {
  const auth = resolveAuth(rawParams);
  // 認可用フィールドはデータに混入しないよう除去
  const { adminKey, driverToken, ...params } = rawParams;

  switch (action) {
    // ── 認証系（未認証で呼べる） ──
    case 'verifyPassword':      return verifyPassword(params);
    case 'verifyAdminKey':      return verifyAdminKey(params);
    case 'verifyDriverToken':   return verifyDriverToken(auth);

    // ── 読み取り系（トークンは管理者のみに返る） ──
    case 'getInit':             return getInit(params, auth);
    case 'getDrivers':          return getDrivers(params, auth);
    case 'getCheckers':         return getCheckers(params);

    // ── ドライバー記録（管理者 or 本人のみ） ──
    case 'getRecords':          return guardDriver(auth, params.driverId) || getRecords(params);
    case 'getRecentRecords':    return guardDriver(auth, params.driverId) || getRecentRecords(params);
    case 'saveRecord':          return guardDriver(auth, params.driverId) || saveRecord(params);
    case 'deleteRecord':        return guardDriver(auth, params.driverId) || deleteRecord(params);
    case 'getStatus':           return guardDriver(auth, params.driverId) || getStatus(params);
    case 'clockIn':             return guardDriver(auth, params.driverId) || clockIn(params);
    case 'clockOut':            return guardDriver(auth, params.driverId) || clockOut(params);
    case 'alcoholCheck':        return guardDriver(auth, params.driverId) || alcoholCheck(params);

    // ── 認証済みユーザーなら可 ──
    case 'saveChecker':         return guardAnyAuth(auth) || saveChecker(params);

    // ── 管理者のみ ──
    case 'saveDriver':          return guardAdmin(auth) || saveDriver(params);
    case 'regenerateDriverToken': return guardAdmin(auth) || regenerateDriverToken(params);

    default:
      return { success: false, error: `未知のaction: ${action}` };
  }
}

module.exports = { dispatch, ACTIONS };
