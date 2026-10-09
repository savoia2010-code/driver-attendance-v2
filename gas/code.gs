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
 *   管理者     : 上記すべて（全ドライバー分）＋ saveDriver / regenerateDriverToken /
 *                generateMonthlySheets（事務所用の月次シートを生成）
 *
 * ■ スクリプトプロパティ（プロジェクトの設定 → スクリプトプロパティ）
 *   SPREADSHEET_ID         … データ保存先スプレッドシートのID（必須）
 *   ACCESS_TOKEN           … アプリ共通トークン。フロントの config.js の APP_TOKEN と同じ値にする
 *   ADMIN_KEY              … 管理者モードのキー（必須・長いランダム文字列を推奨）
 *   MONTHLY_SPREADSHEET_ID … 事務所用の月次シートを書き出す別スプレッドシートのID
 *                            （generateMonthlySheets を使う場合に必須）
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
      case 'generateMonthlySheets':
        return jsonOut_(guardAdmin_(auth) || withLock_(function() { return generateMonthlySheets_(body); }));

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
// 事務所用 月次シート生成（管理者のみ・要ロック済み）
// ============================================================
//
// 締め期間（前月26日〜当月25日）のドライバー1人分を、別スプレッドシート
// （MONTHLY_SPREADSHEET_ID）の1タブ「YY/MM/氏名」に書き出す。
// 列構成は事務所が使っている既存の月次シートに合わせている（A〜EU の151列）。
//
// ・既存タブは作り直す。ただし「仮受金 / 本日送金高 / 差引手持高」の3列は
//   アプリに入力欄が無く事務所が手入力するため、同じ日付の値を引き継ぐ。
// ・時間計算（通常/深夜/時間外/休日/休憩）はフロントの calcRecord と同じ規則。
// ・小計と合計行は数式にして、事務所側で手直ししても再計算されるようにする。

var MONTHLY_NIGHT_START        = 22 * 60;  // 22:00
var MONTHLY_NIGHT_END          =  5 * 60;  //  5:00
var MONTHLY_OVERTIME_THRESHOLD = 470;      // 7時間50分
var MONTHLY_LODGING_AMOUNT     = 5000;
var MONTHLY_MAX_BREAKS         = 6;
var MONTHLY_MAX_VISITS         = 30;
var MONTHLY_MAX_MANUAL_BREAKS  = 8;
var MONTHLY_MAX_FUELS          = 4;

// 列定義。key が null の列は固定ヘッダーのみ（値は行ビルダーで組み立てる）
function monthlyHeaders_() {
  var h = [
    '日付', '配送地', '走行距離', '件数', '完成', 'バラ', 'ワンタッチ',
    '宿泊費', '手当', '手当(不足分)', '手当(受取超過分)', '小計', '給油ℓ合計',
    '通常運行時間', '深夜時間', '時間外', '休日出勤時間', '合計休憩時間',
    '出発時刻', '帰着時刻', '乗務開始地点', '開始メーター(km)', '乗務終了地点', '終了メーター(km)',
    '小物', 'その他',
    '前:確認方法', '前:対面外連絡', '前:酒気有無', '前:確認者', '前:確認日時',
    '後:確認方法', '後:対面外連絡', '後:酒気有無', '後:確認者', '後:確認日時',
    '給油店名', '軽油(ℓ)', 'レギュラー(ℓ)', 'アドブルー(ℓ)',
    '仮受金', '本日送金高', '差引手持高', '保存日時',
  ];
  var i;
  for (i = 1; i <= MONTHLY_MAX_BREAKS; i++) h.push('休憩' + i + '開始', '休憩' + i + '終了', '休憩' + i + '場所');
  for (i = 1; i <= MONTHLY_MAX_VISITS; i++) h.push('訪問先' + i, '報告事項' + i);
  h.push('分数休憩合計(分)');
  for (i = 1; i <= MONTHLY_MAX_MANUAL_BREAKS; i++) h.push('分数休憩' + i + '(分)');
  for (i = 1; i <= MONTHLY_MAX_FUELS; i++) {
    h.push('給油' + i + '店名', '給油' + i + '軽油(ℓ)', '給油' + i + 'レギュラー(ℓ)', '給油' + i + 'アドブルー(ℓ)', '給油' + i + 'ODメーター(km)');
  }
  return h;
}

// 1行目のグループ見出し（列名 → 見出し）
var MONTHLY_GROUP_LABELS = {
  '深夜時間': '運転日報', '仮受金': '出張報告書', '休憩1開始': '休憩',
  '訪問先1': '訪問先・報告事項', '分数休憩1(分)': '分数休憩', '給油1店名': '給油詳細',
};

// 事務所が手入力する列（再生成時に値を引き継ぐ）
var MONTHLY_PRESERVED_COLUMNS = ['仮受金', '本日送金高', '差引手持高'];

// 合計行で SUM を立てる列
var MONTHLY_SUM_COLUMNS = [
  '走行距離', '件数', '完成', 'バラ', '宿泊費', '手当', '手当(不足分)', '手当(受取超過分)', '小計', '給油ℓ合計',
  '通常運行時間', '深夜時間', '時間外', '休日出勤時間', '合計休憩時間',
  '小物', 'その他', '軽油(ℓ)', 'レギュラー(ℓ)', 'アドブルー(ℓ)', '分数休憩合計(分)',
];

// 時間（h:mm 表示）の列
var MONTHLY_DURATION_COLUMNS = ['通常運行時間', '深夜時間', '時間外', '休日出勤時間', '合計休憩時間'];

function generateMonthlySheets_(p) {
  var ssId = props_().getProperty('MONTHLY_SPREADSHEET_ID');
  if (!ssId) return { success: false, error: 'スクリプトプロパティ MONTHLY_SPREADSHEET_ID が未設定です' };

  // periodEnd: 'YYYY-MM'（締め月＝25日が属する月）。省略時は今の締め期間
  var m = /^(\d{4})-(\d{2})$/.exec(String(p.periodEnd || ''));
  var endYear, endMonth;  // endMonth は 1〜12
  if (m) {
    endYear = Number(m[1]); endMonth = Number(m[2]);
  } else {
    var now = new Date();
    endYear = now.getFullYear(); endMonth = now.getMonth() + 1;
    if (now.getDate() > 25) { endMonth++; if (endMonth > 12) { endMonth = 1; endYear++; } }
  }
  var periodStart = new Date(endYear, endMonth - 2, 26);  // 前月26日（月は0始まり）
  var periodEnd   = new Date(endYear, endMonth - 1, 25);
  var fromKey = dateKey_(periodStart), toKey = dateKey_(periodEnd);

  var drivers = readDrivers_();
  if (p.driverId) {
    drivers = drivers.filter(function(d) { return d.id === p.driverId; });
    if (!drivers.length) return { success: false, error: '対象のドライバーが見つかりません' };
  }

  var allRecords = readAllRecords_().filter(function(r) { return r.date >= fromKey && r.date <= toKey; });
  var ss = SpreadsheetApp.openById(ssId);
  var created = [], skipped = [];

  drivers.forEach(function(d) {
    var recs = allRecords.filter(function(r) { return r.driverId === d.id; });
    // 全員生成のときは記録の無い人を飛ばす（空タブで埋まらないように）。個別指定なら空でも作る
    if (!recs.length && !p.driverId) { skipped.push(d.name); return; }
    var byDate = {};
    recs.forEach(function(r) { byDate[r.date] = r; });
    var sheetName = buildMonthlySheet_(ss, d, endYear, endMonth, periodStart, periodEnd, byDate);
    created.push(sheetName);
  });

  return { success: true, url: ss.getUrl(), sheets: created, skipped: skipped };
}

function buildMonthlySheet_(ss, driver, endYear, endMonth, periodStart, periodEnd, byDate) {
  var headers = monthlyHeaders_();
  var col = {};  // 列名 → 1始まりの列番号
  headers.forEach(function(h, i) { col[h] = i + 1; });
  var ncol = headers.length;

  var yy = String(endYear).slice(2);
  var mm = ('0' + endMonth).slice(-2);
  var sheetName = yy + '/' + mm + '/' + driver.name;

  // 期間内の日付を列挙
  var days = [];
  for (var dt = new Date(periodStart); dt <= periodEnd; dt.setDate(dt.getDate() + 1)) days.push(new Date(dt));
  var firstDataRow = 3;
  var repeatRow    = firstDataRow + days.length;   // ヘッダー再掲
  var totalRow     = repeatRow + 1;                // 合計

  // 既存タブがあれば、事務所が手入力した列を日付ごとに退避してから作り直す
  var preserved = {};
  var old = ss.getSheetByName(sheetName);
  if (old) {
    var oldHeader = old.getRange(2, 1, 1, old.getLastColumn()).getValues()[0];
    var oldDayCol = oldHeader.indexOf('日付');
    var oldLast = old.getLastRow();
    if (oldDayCol >= 0 && oldLast >= firstDataRow) {
      var oldVals = old.getRange(firstDataRow, 1, oldLast - firstDataRow + 1, old.getLastColumn()).getValues();
      oldVals.forEach(function(row) {
        var day = String(row[oldDayCol]);
        if (!/^\d+$/.test(day)) return;  // ヘッダー再掲・合計行は飛ばす
        var keep = {};
        MONTHLY_PRESERVED_COLUMNS.forEach(function(name) {
          var c = oldHeader.indexOf(name);
          if (c >= 0 && row[c] !== '') keep[name] = row[c];
        });
        if (Object.keys(keep).length) preserved[day] = keep;
      });
    }
    ss.deleteSheet(old);
  }

  var sheet = ss.insertSheet(sheetName);

  // ── 1行目：氏名・年月・グループ見出し ──
  var row1 = new Array(ncol).fill('');
  row1[0] = driver.name;
  row1[1] = endYear + '年度' + endMonth + '月';
  Object.keys(MONTHLY_GROUP_LABELS).forEach(function(name) { row1[col[name] - 1] = MONTHLY_GROUP_LABELS[name]; });

  // ── データ行 ──
  var rows = days.map(function(d, i) {
    var key = dateKey_(d);
    var row = monthlyRow_(byDate[key] || null, key, col, ncol);
    var day = String(d.getDate());
    row[0] = d.getDate();
    if (preserved[day]) {
      MONTHLY_PRESERVED_COLUMNS.forEach(function(name) {
        if (name in preserved[day]) row[col[name] - 1] = preserved[day][name];
      });
    }
    return row;
  });

  // ── ヘッダー再掲行（元のシートに合わせ、保存日時までと訪問先・報告事項のみ） ──
  var repeat = headers.map(function(h) {
    return (col[h] <= col['保存日時'] || /^(訪問先|報告事項)\d+$/.test(h)) ? h : '';
  });

  // 時間列は「分」→「日の割合」にして h:mm 表示・SUM 可能にする
  rows.forEach(function(r) {
    MONTHLY_DURATION_COLUMNS.forEach(function(name) {
      var v = r[col[name] - 1];
      if (v !== '') r[col[name] - 1] = v / 1440;
    });
  });

  var values = [row1, headers].concat(rows, [repeat, new Array(ncol).fill('')]);
  var range = sheet.getRange(1, 1, values.length, ncol);

  // 書式は値を入れる前に決める（後から変えても、文字列として入った数値は数値に戻らない）
  range.setNumberFormat('@');  // 「08:00」等の時刻文字列が勝手に変換されないよう基本は文字列扱い
  var numericCols = MONTHLY_SUM_COLUMNS.concat(['開始メーター(km)', '終了メーター(km)', '仮受金', '本日送金高', '差引手持高']);
  numericCols.forEach(function(name) {
    var isDur = MONTHLY_DURATION_COLUMNS.indexOf(name) >= 0;
    sheet.getRange(firstDataRow, col[name], days.length + 2, 1).setNumberFormat(isDur ? '[h]:mm' : '0.##');
  });
  sheet.getRange(firstDataRow, 1, days.length, 1).setNumberFormat('0');  // 日付（日）
  range.setValues(values);

  // ── 数式：小計（宿泊費＋手当。フロントの月次集計と同じ）・合計行 ──
  var hCol = colLetter_(col['宿泊費']), iCol = colLetter_(col['手当']);
  var subFormulas = rows.map(function(_, i) {
    var r = firstDataRow + i;
    return ['=' + hCol + r + '+' + iCol + r];
  });
  sheet.getRange(firstDataRow, col['小計'], days.length, 1).setFormulas(subFormulas);

  sheet.getRange(totalRow, col['ワンタッチ']).setValue('合計');
  MONTHLY_SUM_COLUMNS.forEach(function(name) {
    var L = colLetter_(col[name]);
    sheet.getRange(totalRow, col[name]).setFormula('=SUM(' + L + firstDataRow + ':' + L + (repeatRow - 1) + ')');
  });

  // ── 体裁 ──
  sheet.setFrozenRows(2);
  sheet.setFrozenColumns(1);
  sheet.getRange(1, 1, 2, ncol).setFontWeight('bold');
  sheet.getRange(repeatRow, 1, 2, ncol).setFontWeight('bold');
  sheet.getRange(1, 1).setFontSize(14);
  sheet.setColumnWidth(1, 40);
  // 週末の行に薄く色を付ける
  days.forEach(function(d, i) {
    var dow = d.getDay();
    if (dow === 0 || dow === 6) sheet.getRange(firstDataRow + i, 1, 1, ncol).setBackground('#f3f3f3');
  });

  return sheetName;
}

// 1日分のレコードを列順の配列にする（rec が null なら日付以外は空）
function monthlyRow_(rec, dateKey, col, ncol) {
  var row = new Array(ncol).fill('');
  if (!rec) return row;
  var set = function(name, v) { row[col[name] - 1] = (v === null || v === undefined) ? '' : v; };

  var calc = monthlyCalc_(rec, dateKey);
  var startKm = numOrBlank_(rec.startMileage), endKm = numOrBlank_(rec.endMileage);
  var visits = rec.visits || [], allowances = rec.allowances || [];
  var fuels = rec.fuelEntries || [], breaks = rec.breaks || [], manual = rec.manualBreaks || [];

  var allowSum = allowances.reduce(function(s, a) { return s + toNum_(a.amount); }, 0);
  var fuelTotal = fuels.reduce(function(s, f) { return s + toNum_(f.fuel) + toNum_(f.fuelRegular); }, 0);

  set('配送地', rec.destination || '');
  set('走行距離', (startKm !== '' && endKm !== '') ? endKm - startKm : '');
  set('件数', rec.count !== undefined && rec.count !== '' ? toNum_(rec.count) : (visits.length || ''));
  set('完成', numOrBlank_(rec.kumitate));
  set('バラ', numOrBlank_(rec.bara));
  set('ワンタッチ', numOrBlank_(rec.onetouch));
  set('宿泊費', rec.lodging ? MONTHLY_LODGING_AMOUNT : 0);
  set('手当', allowSum);
  set('手当(不足分)', numOrBlank_(rec.allowanceShortfall));
  set('手当(受取超過分)', numOrBlank_(rec.allowanceExcess));
  set('給油ℓ合計', fuelTotal || '');
  if (calc) {
    set('通常運行時間', calc.normalMins);
    set('深夜時間', calc.nightMins);
    set('時間外', calc.overtime);
    set('休日出勤時間', calc.holidayMins);
    set('合計休憩時間', calc.breakMins);
  }
  set('出発時刻', rec.clockIn || rec.start || '');
  set('帰着時刻', rec.clockOut || rec.end || '');
  set('乗務開始地点', rec.startPlace || '');
  set('開始メーター(km)', startKm);
  set('乗務終了地点', rec.endPlace || '');
  set('終了メーター(km)', endKm);
  set('小物', numOrBlank_(rec.kobutsu));
  set('その他', numOrBlank_(rec.other));
  set('前:確認方法', rec.alcBMethod || ''); set('前:対面外連絡', rec.alcBRemote || '');
  set('前:酒気有無', rec.alcBResult || ''); set('前:確認者', rec.alcBChecker || '');
  set('前:確認日時', fmtJst_(rec.alcBDate, 'yyyy/MM/dd HH:mm'));
  set('後:確認方法', rec.alcAMethod || ''); set('後:対面外連絡', rec.alcARemote || '');
  set('後:酒気有無', rec.alcAResult || ''); set('後:確認者', rec.alcAChecker || '');
  set('後:確認日時', fmtJst_(rec.alcADate, 'yyyy/MM/dd HH:mm'));
  set('給油店名', fuels.map(function(f) { return f.shop || ''; }).filter(String).join('、'));
  set('軽油(ℓ)', sumOrBlank_(fuels, 'fuel'));
  set('レギュラー(ℓ)', sumOrBlank_(fuels, 'fuelRegular'));
  set('アドブルー(ℓ)', sumOrBlank_(fuels, 'adblue'));
  set('保存日時', fmtJst_(rec.savedAt, 'yyyy/MM/dd'));

  var i;
  for (i = 0; i < MONTHLY_MAX_BREAKS && i < breaks.length; i++) {
    set('休憩' + (i + 1) + '開始', breaks[i].start || '');
    set('休憩' + (i + 1) + '終了', breaks[i].end || '');
    set('休憩' + (i + 1) + '場所', breaks[i].place || '');
  }
  for (i = 0; i < MONTHLY_MAX_VISITS && i < visits.length; i++) {
    set('訪問先' + (i + 1), visits[i].place || '');
    set('報告事項' + (i + 1), visits[i].report || '');
  }
  var manualSum = manual.reduce(function(s, b) { return s + toNum_(b.mins); }, 0);
  set('分数休憩合計(分)', manualSum || '');
  for (i = 0; i < MONTHLY_MAX_MANUAL_BREAKS && i < manual.length; i++) {
    set('分数休憩' + (i + 1) + '(分)', numOrBlank_(manual[i].mins));
  }
  for (i = 0; i < MONTHLY_MAX_FUELS && i < fuels.length; i++) {
    set('給油' + (i + 1) + '店名', fuels[i].shop || '');
    set('給油' + (i + 1) + '軽油(ℓ)', numOrBlank_(fuels[i].fuel));
    set('給油' + (i + 1) + 'レギュラー(ℓ)', numOrBlank_(fuels[i].fuelRegular));
    set('給油' + (i + 1) + 'アドブルー(ℓ)', numOrBlank_(fuels[i].adblue));
    set('給油' + (i + 1) + 'ODメーター(km)', numOrBlank_(fuels[i].odometer));
  }
  return row;
}

// フロントの calcRecord と同じ規則で時間を分単位で算出する
function monthlyCalc_(rec, dateKey) {
  var start = parseHHMM_(rec.clockIn || rec.start);
  var end   = parseHHMM_(rec.clockOut || rec.end);
  if (start === null || end === null) return null;
  var endAdj = end < start ? end + 1440 : end;

  var breaks = (rec.breaks || []).filter(function(b) { return b.start && b.end; }).map(function(b) {
    var bs = parseHHMM_(b.start), be = parseHHMM_(b.end);
    if (bs < start) bs += 1440;
    if (be < bs)    be += 1440;
    return { s: bs, e: be };
  }).sort(function(a, b) { return a.s - b.s; });

  var segs = [], cursor = start;
  breaks.forEach(function(br) {
    if (br.s > cursor) segs.push({ s: cursor, e: br.s });
    cursor = br.e;
  });
  if (endAdj > cursor) segs.push({ s: cursor, e: endAdj });

  var workMins = 0, nightMins = 0;
  segs.forEach(function(seg) {
    var n = countNightMins_(seg.s, seg.e);
    nightMins += n;
    workMins  += (seg.e - seg.s) - n;
  });
  var timedBreak = breaks.reduce(function(s, b) { return s + (b.e - b.s); }, 0);
  var manualMins = (rec.manualBreaks || []).reduce(function(s, b) { return s + toNum_(b.mins); }, 0);
  workMins = Math.max(0, workMins - manualMins);

  var isHoliday   = rec.type === 'holiday' || isWeekend_(rec.date || rec.startDate || dateKey);
  var overtime    = isHoliday ? 0 : Math.max(0, workMins - MONTHLY_OVERTIME_THRESHOLD);
  var normalMins  = isHoliday ? 0 : workMins - overtime;
  var holidayMins = isHoliday ? workMins : 0;
  return { normalMins: normalMins, overtime: overtime, nightMins: nightMins,
           holidayMins: holidayMins, breakMins: timedBreak + manualMins };
}

function countNightMins_(s, e) {
  var n = 0;
  for (var t = s; t < e; t++) {
    var tm = t % 1440;
    if (tm >= MONTHLY_NIGHT_START || tm < MONTHLY_NIGHT_END) n++;
  }
  return n;
}

function parseHHMM_(s) {
  if (!s) return null;
  var parts = String(s).split(':');
  var h = Number(parts[0]), m = Number(parts[1]);
  return (isNaN(h) || isNaN(m)) ? null : h * 60 + m;
}

function isWeekend_(ds) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ds || ''));
  if (!m) return false;
  var dow = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay();
  return dow === 0 || dow === 6;
}

function dateKey_(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
}

function fmtJst_(iso, pattern) {
  if (!iso) return '';
  var d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : Utilities.formatDate(d, 'Asia/Tokyo', pattern);
}

// 全角数字・単位混じりでも数値として読む（フロントの toNum と同じ規則）。読めなければ 0
function toNum_(v) {
  var s = String(v === null || v === undefined ? '' : v)
    .replace(/[０-９．－，]/g, function(ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
    .replace(/[^0-9.\-]/g, '');
  var n = Number(s);
  return (s === '' || isNaN(n)) ? 0 : n;
}

// 空なら空のまま、入っていれば数値にする
function numOrBlank_(v) {
  if (v === null || v === undefined || v === '') return '';
  return toNum_(v);
}

function sumOrBlank_(items, key) {
  var any = false, sum = 0;
  items.forEach(function(it) { if (it[key] !== '' && it[key] !== undefined) { any = true; sum += toNum_(it[key]); } });
  return any ? sum : '';
}

function colLetter_(n) {
  var s = '';
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
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
