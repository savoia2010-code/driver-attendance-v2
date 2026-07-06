/**
 * 勤怠管理アプリ GASバックエンド
 *
 * ■ 認可モデル（3層）
 *   1. ACCESS_TOKEN   … アプリ共通トークン（bot除け程度。config.js は公開されるため秘密ではない）
 *   2. driverToken    … ドライバー個人の秘密トークン（url_token）。自分の記録の読み書きのみ許可
 *   3. adminKey       … 管理者キー。全ドライバーの記録・マスタ管理を許可（総当たり対策あり）
 *
 * 対応アクション：
 *   認証不要   : verifyAdminKey / verifyDriverToken
 *   ドライバー : getInit / getDrivers / getCheckers（トークンは返らない）/
 *                getRecords / getRecentRecords / saveRecord / deleteRecord（自分の分のみ）/
 *                saveChecker
 *   管理者     : 上記すべて（全ドライバー分）＋ saveDriver / regenerateDriverToken
 *
 * ■ スクリプトプロパティ（プロジェクトの設定 → スクリプトプロパティ）
 *   SPREADSHEET_ID … データ保存先スプレッドシートのID（必須）
 *   ACCESS_TOKEN   … アプリ共通トークン。フロントの config.js の APP_TOKEN と同じ値にする
 *   ADMIN_KEY      … 管理者モードのキー（必須・長いランダム文字列を推奨）
 *
 * ■ シート構造（無ければ自動作成される）
 *   drivers  : id | name | url_token
 *   checkers : id | name
 *   records  : driverId | date | driverName | clockIn | clockOut | status | savedAt | json
 *              → レコード本体は json 列（全フィールドのJSON）。他の列は閲覧用。
 *
 * ■ 同時書き込み対策
 *   書き込み系アクションは LockService で直列化（read-modify-write の原子性を確保）。
 *   saveRecord は baseSavedAt による楽観的競合検知に対応（mock-server と同一仕様）。
 */

// ============================================================
// エントリポイント
// ============================================================

function doPost(e) {
  var body;
  try {
    // フロントは text/plain で送信する（application/json だと
    // CORSプリフライトが発生し、GASは OPTIONS に応答できないため）
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ success: false, error: 'リクエストの形式が不正です' });
  }

  // ── 第1層：アプリ共通トークン ──
  var requiredToken = props_().getProperty('ACCESS_TOKEN');
  if (requiredToken && body.token !== requiredToken) {
    return jsonOut_({ success: false, error: 'unauthorized' });
  }

  // ── 第2層：認可コンテキストを解決（adminKey / driverToken） ──
  var auth = resolveAuth_(body);

  // 認可用フィールドはデータに混入しないよう除去
  delete body.token;
  delete body.adminKey;
  delete body.driverToken;

  var action = body.action;
  delete body.action;

  try {
    switch (action) {
      // ── 認証系（未認証で呼べる） ──
      case 'verifyAdminKey':    return jsonOut_(verifyAdminKey_(body));
      case 'verifyDriverToken': return jsonOut_(verifyDriverToken_(auth));

      // ── 読み取り系 ──
      case 'getInit':           return jsonOut_(getInit_(auth));
      case 'getDrivers':        return jsonOut_(getDrivers_(auth));
      case 'getCheckers':       return jsonOut_({ success: true, checkers: readCheckers_() });
      case 'getRecords':        return jsonOut_(guardDriver_(auth, body.driverId) || getRecords_(body));
      case 'getRecentRecords':  return jsonOut_(guardDriver_(auth, body.driverId) || getRecentRecords_(body));

      // ── 書き込み系（LockServiceで直列化） ──
      case 'saveRecord':
        return jsonOut_(guardDriver_(auth, body.driverId) || withLock_(function() { return saveRecord_(body); }));
      case 'deleteRecord':
        return jsonOut_(guardDriver_(auth, body.driverId) || withLock_(function() { return deleteRecord_(body); }));
      case 'saveChecker':
        return jsonOut_(guardAnyAuth_(auth) || withLock_(function() { return saveChecker_(body); }));
      case 'saveDriver':
        return jsonOut_(guardAdmin_(auth) || withLock_(function() { return saveDriver_(body); }));
      case 'regenerateDriverToken':
        return jsonOut_(guardAdmin_(auth) || withLock_(function() { return regenerateDriverToken_(body); }));

      default:
        return jsonOut_({ success: false, error: '未知のaction: ' + action });
    }
  } catch (err) {
    return jsonOut_({ success: false, error: String(err && err.message || err) });
  }
}

function doGet(e) {
  // 死活確認用（データは返さない）
  return jsonOut_({ status: 'ok' });
}

// ============================================================
// 認可
// ============================================================

// リクエストの adminKey / driverToken から認可コンテキストを作る
function resolveAuth_(body) {
  var auth = { isAdmin: false, driver: null };

  var adminKey = props_().getProperty('ADMIN_KEY');
  if (adminKey && body.adminKey && body.adminKey === adminKey) {
    auth.isAdmin = true;
  }

  if (body.driverToken) {
    var drivers = readDrivers_();
    for (var i = 0; i < drivers.length; i++) {
      // トークンが空のドライバーは照合対象にしない（空文字一致の抜け穴を防ぐ）
      if (drivers[i].url_token && drivers[i].url_token === body.driverToken) {
        auth.driver = drivers[i];
        break;
      }
    }
  }
  return auth;
}

// 指定ドライバーの記録への操作権限：管理者 or 本人のみ。エラー時はレスポンス、OKなら null
function guardDriver_(auth, driverId) {
  if (auth.isAdmin) return null;
  if (auth.driver && driverId && auth.driver.id === driverId) return null;
  return { success: false, error: 'forbidden' };
}

// 管理者またはいずれかの正規ドライバーであること（確認者追加用）
function guardAnyAuth_(auth) {
  return (auth.isAdmin || auth.driver) ? null : { success: false, error: 'forbidden' };
}

// 管理者であること
function guardAdmin_(auth) {
  return auth.isAdmin ? null : { success: false, error: 'forbidden' };
}

// 管理者キーの検証（総当たり対策：連続失敗でロックアウト）
var ADMIN_FAIL_LIMIT   = 5;
var ADMIN_LOCK_SECONDS = 600;  // 10分

function verifyAdminKey_(p) {
  var adminKey = props_().getProperty('ADMIN_KEY');
  if (!adminKey) return { success: false, error: 'ADMIN_KEY が未設定です' };

  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('adminKeyFails') || 0);
  if (fails >= ADMIN_FAIL_LIMIT) {
    return { success: false, error: '試行回数の上限に達しました。しばらく待ってから再試行してください' };
  }

  if (p.key === adminKey) {
    cache.remove('adminKeyFails');
    return { success: true };
  }
  cache.put('adminKeyFails', String(fails + 1), ADMIN_LOCK_SECONDS);
  return { success: false };
}

// ドライバートークンから本人情報を返す（専用URL起動時の解決用）
function verifyDriverToken_(auth) {
  if (!auth.driver) return { success: false, error: 'invalid token' };
  return { success: true, driver: { id: auth.driver.id, name: auth.driver.name } };
}

// ============================================================
// アクション実装
// ============================================================

// url_token はドライバー個人の秘密。管理者以外には返さない
function stripTokens_(drivers, auth) {
  return drivers.map(function(d) {
    return auth.isAdmin
      ? { id: d.id, name: d.name, url_token: d.url_token || '' }
      : { id: d.id, name: d.name };
  });
}

function getInit_(auth) {
  return {
    success: true,
    drivers: stripTokens_(readDrivers_(), auth),
    checkers: readCheckers_(),
  };
}

function getDrivers_(auth) {
  return { success: true, drivers: stripTokens_(readDrivers_(), auth) };
}

function getRecords_(p) {
  if (!p.driverId) return { success: false, error: 'driverId が必要です' };
  var records = readAllRecords_()
    .filter(function(r) { return r.driverId === p.driverId; })
    .filter(function(r) { return !p.from || r.date >= p.from; })
    .filter(function(r) { return !p.to   || r.date <= p.to; })
    .sort(function(a, b) { return a.date < b.date ? -1 : 1; });
  return { success: true, records: records };
}

function getRecentRecords_(p) {
  if (!p.driverId) return { success: false, error: 'driverId が必要です' };
  var records = readAllRecords_()
    .filter(function(r) { return r.driverId === p.driverId; })
    .sort(function(a, b) { return a.date < b.date ? 1 : -1; })
    .slice(0, Number(p.limit) || 10);
  return { success: true, records: records };
}

// 保存を許可するレコードのフィールド（フロントの buildRecord と一致させる）
// これ以外のフィールドは破棄する：任意フィールド注入によるデータ汚染・肥大化を防ぐ
var RECORD_ALLOWED_FIELDS = [
  'driverId', 'driverName', 'date', 'clockIn', 'clockOut', 'status',
  'breaks', 'manualBreaks', 'fuelEntries',
  'destination', 'note', 'startMileage', 'endMileage', 'startPlace', 'endPlace',
  'lodging', 'kumitate', 'bara', 'onetouch', 'kobutsu', 'other', 'count', 'distance',
  'visits', 'allowances', 'allowanceShortfall', 'allowanceExcess',
  'alcBMethod', 'alcBRemote', 'alcBResult', 'alcBChecker', 'alcBDate',
  'alcAMethod', 'alcARemote', 'alcAResult', 'alcAChecker', 'alcADate',
];
var RECORD_MAX_JSON_LENGTH = 100000;  // 1レコードの上限（約100KB）

// 日報レコードを driverId + date で upsert（要ロック済み）
function saveRecord_(data) {
  if (!data.driverId || !data.date) return { success: false, error: 'driverId と date が必要です' };
  var dateStr = String(data.date).slice(0, 10);  // YYYY-MM-DD に正規化

  var sheet = recordsSheet_();
  var rowIndex = findRecordRow_(sheet, data.driverId, dateStr);  // 見つからなければ -1

  // ── 楽観的競合検知（mock-server と同一仕様） ──
  // baseSavedAt が空・未指定なら従来どおり上書き保存
  if (rowIndex > 0 && data.baseSavedAt) {
    var existing = rowToRecord_(sheet, rowIndex);
    if (existing && existing.savedAt && data.baseSavedAt !== existing.savedAt) {
      return { success: false, error: 'conflict', latest: existing };
    }
  }

  // ホワイトリストのフィールドのみ保存（baseSavedAt もここで自然に落ちる）
  var record = {};
  for (var i = 0; i < RECORD_ALLOWED_FIELDS.length; i++) {
    var k = RECORD_ALLOWED_FIELDS[i];
    if (k in data) record[k] = data[k];
  }
  record.date = dateStr;
  record.savedAt = new Date().toISOString();  // サーバー側で付与（ミリ秒精度）
  if (JSON.stringify(record).length > RECORD_MAX_JSON_LENGTH) {
    return { success: false, error: '記録データが大きすぎます' };
  }

  var row = [
    record.driverId,
    record.date,
    record.driverName || '',
    record.clockIn    || '',
    record.clockOut   || '',
    record.status     || '',
    record.savedAt,
    JSON.stringify(record),
  ];
  if (rowIndex > 0) {
    sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
  return { success: true, message: '記録を保存しました', record: record };
}

// 記録削除（要ロック済み）
function deleteRecord_(p) {
  if (!p.driverId || !p.date) return { success: false, error: 'driverId と date が必要です' };
  var dateStr = String(p.date).slice(0, 10);
  var sheet = recordsSheet_();
  var rowIndex = findRecordRow_(sheet, p.driverId, dateStr);
  if (rowIndex < 0) return { success: false, error: '削除対象の記録が見つかりません' };
  sheet.deleteRow(rowIndex);
  return { success: true, message: '記録を削除しました' };
}

// ドライバーを id で upsert（管理者のみ・要ロック済み）
// 新規追加時は url_token（専用URLの秘密トークン）をサーバー側で自動生成して返す
function saveDriver_(p) {
  if (!p.id || !p.name) return { success: false, error: 'id と name が必要です' };
  var sheet = driversSheet_();
  var values = sheet.getDataRange().getDisplayValues();
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === p.id) {
      sheet.getRange(i + 1, 2).setValue(p.name);
      return { success: true, message: 'ドライバー名を更新しました',
               driver: { id: p.id, name: p.name, url_token: values[i][2] || '' } };
    }
  }
  var urlToken = newToken_();
  sheet.appendRow([p.id, p.name, urlToken]);
  return { success: true, message: 'ドライバーを追加しました',
           driver: { id: p.id, name: p.name, url_token: urlToken } };
}

// ドライバーの url_token を再発行（管理者のみ・要ロック済み）
// 事前登録済みでトークンが空／推測されやすい場合や、URLが漏れた場合の無効化に使う
function regenerateDriverToken_(p) {
  if (!p.id) return { success: false, error: 'id が必要です' };
  var sheet = driversSheet_();
  var values = sheet.getDataRange().getDisplayValues();
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === p.id) {
      var urlToken = newToken_();
      sheet.getRange(i + 1, 3).setValue(urlToken);
      return { success: true, message: '専用URLを再発行しました',
               driver: { id: values[i][0], name: values[i][1], url_token: urlToken } };
    }
  }
  return { success: false, error: '対象のドライバーが見つかりません' };
}

// 確認者を追加（重複チェックあり・要ロック済み）
function saveChecker_(p) {
  if (!p.name) return { success: false, error: 'name が必要です' };
  var sheet = checkersSheet_();
  var values = sheet.getDataRange().getDisplayValues();
  for (var i = 1; i < values.length; i++) {
    if (values[i][1] === p.name) return { success: true, message: '登録済みの確認者です' };
  }
  sheet.appendRow(['C' + Date.now(), p.name]);
  return { success: true, message: '確認者を追加しました' };
}

// ============================================================
// シートアクセス
// ============================================================

var RECORDS_HEADER  = ['driverId', 'date', 'driverName', 'clockIn', 'clockOut', 'status', 'savedAt', 'json'];
var DRIVERS_HEADER  = ['id', 'name', 'url_token'];
var CHECKERS_HEADER = ['id', 'name'];

function spreadsheet_() {
  var id = props_().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('スクリプトプロパティ SPREADSHEET_ID が未設定です');
  return SpreadsheetApp.openById(id);
}

// シートを取得（無ければヘッダー付きで作成）
function getSheet_(name, header) {
  var ss = spreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(header);
    // 日付・数値の自動変換で値が壊れないよう、全列を書式「書式なしテキスト」にする
    sheet.getRange(1, 1, sheet.getMaxRows(), header.length).setNumberFormat('@');
  }
  return sheet;
}

function recordsSheet_()  { return getSheet_('records',  RECORDS_HEADER); }
function driversSheet_()  { return getSheet_('drivers',  DRIVERS_HEADER); }
function checkersSheet_() { return getSheet_('checkers', CHECKERS_HEADER); }

function readDrivers_() {
  var values = driversSheet_().getDataRange().getDisplayValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;
    out.push({ id: values[i][0], name: values[i][1], url_token: values[i][2] || '' });
  }
  return out;
}

function readCheckers_() {
  var values = checkersSheet_().getDataRange().getDisplayValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    if (!values[i][1]) continue;
    out.push({ id: values[i][0], name: values[i][1] });
  }
  return out;
}

function readAllRecords_() {
  var values = recordsSheet_().getDataRange().getDisplayValues();
  var jsonCol = RECORDS_HEADER.indexOf('json');
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var raw = values[i][jsonCol];
    if (!raw) continue;
    try { out.push(JSON.parse(raw)); } catch (e) { /* 壊れた行はスキップ */ }
  }
  return out;
}

// driverId + date が一致する行番号（1始まり）を返す。無ければ -1
function findRecordRow_(sheet, driverId, dateStr) {
  var values = sheet.getDataRange().getDisplayValues();
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === driverId && String(values[i][1]).slice(0, 10) === dateStr) return i + 1;
  }
  return -1;
}

function rowToRecord_(sheet, rowIndex) {
  var jsonCol = RECORDS_HEADER.indexOf('json');
  var raw = sheet.getRange(rowIndex, jsonCol + 1).getDisplayValue();
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// ============================================================
// ユーティリティ
// ============================================================

function props_() {
  return PropertiesService.getScriptProperties();
}

// 推測不可能なトークンを生成（UUID v4 ベース・ハイフン除去で32文字）
function newToken_() {
  return Utilities.getUuid().replace(/-/g, '');
}

// 書き込み処理を直列化する（同時書き込みによる行の二重追加・消失を防ぐ）
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);  // 最大10秒待つ
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
