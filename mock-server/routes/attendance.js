const fs = require('fs');
const path = require('path');

const driversPath = path.join(__dirname, '../data/drivers.json');
const recordsPath = path.join(__dirname, '../data/records.json');

function loadDrivers() {
  return JSON.parse(fs.readFileSync(driversPath, 'utf8'));
}

function loadRecords() {
  return JSON.parse(fs.readFileSync(recordsPath, 'utf8'));
}

function saveRecords(records) {
  fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2), 'utf8');
}

function nowJST() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

function todayJST() {
  return new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

// ドライバー一覧取得
function getDrivers() {
  const drivers = loadDrivers();
  return { success: true, drivers };
}

// 現在の出勤状態取得
function getStatus(params) {
  const { driverId } = params;
  if (!driverId) return { success: false, error: 'driverId が必要です' };

  const drivers = loadDrivers();
  const driver = drivers.find(d => d.id === driverId);
  if (!driver) return { success: false, error: 'ドライバーが見つかりません' };

  const records = loadRecords();
  const today = todayJST();
  const todayRecord = records.find(r => r.driverId === driverId && r.date === today);

  return {
    success: true,
    driverName: driver.name,
    date: today,
    status: todayRecord ? todayRecord.status : 'none',
    record: todayRecord || null
  };
}

// 出勤打刻
function clockIn(params) {
  const { driverId } = params;
  if (!driverId) return { success: false, error: 'driverId が必要です' };

  const drivers = loadDrivers();
  const driver = drivers.find(d => d.id === driverId);
  if (!driver) return { success: false, error: 'ドライバーが見つかりません' };

  const records = loadRecords();
  const today = todayJST();
  const existing = records.find(r => r.driverId === driverId && r.date === today);

  if (existing && existing.clockIn) {
    return { success: false, error: '本日はすでに出勤打刻済みです' };
  }

  const newRecord = {
    id: `${driverId}-${Date.now()}`,
    driverId,
    driverName: driver.name,
    date: today,
    clockIn: nowJST(),
    clockOut: null,
    alcoholCheck: null,
    status: 'working'
  };

  records.push(newRecord);
  saveRecords(records);

  return { success: true, message: '出勤打刻しました', record: newRecord };
}

// 退勤打刻
function clockOut(params) {
  const { driverId } = params;
  if (!driverId) return { success: false, error: 'driverId が必要です' };

  const records = loadRecords();
  const today = todayJST();
  const recordIndex = records.findIndex(r => r.driverId === driverId && r.date === today && r.status === 'working');

  if (recordIndex === -1) {
    return { success: false, error: '出勤中の記録が見つかりません' };
  }

  records[recordIndex].clockOut = nowJST();
  records[recordIndex].status = 'done';
  saveRecords(records);

  return { success: true, message: '退勤打刻しました', record: records[recordIndex] };
}

// アルコールチェック
function alcoholCheck(params) {
  const { driverId, value } = params;
  if (!driverId) return { success: false, error: 'driverId が必要です' };
  if (value === undefined || value === null || value === '') {
    return { success: false, error: 'アルコール値（value）が必要です' };
  }

  const numValue = parseFloat(value);
  if (isNaN(numValue)) {
    return { success: false, error: 'アルコール値は数値で入力してください' };
  }

  const records = loadRecords();
  const today = todayJST();
  const recordIndex = records.findIndex(r => r.driverId === driverId && r.date === today);

  if (recordIndex === -1) {
    return { success: false, error: '本日の打刻記録が見つかりません' };
  }

  records[recordIndex].alcoholCheck = {
    value: numValue,
    time: nowJST(),
    result: numValue === 0 ? 'pass' : 'fail'
  };
  saveRecords(records);

  return {
    success: true,
    message: 'アルコールチェックを記録しました',
    value: numValue,
    result: numValue === 0 ? 'pass' : 'fail'
  };
}

module.exports = { getDrivers, getStatus, clockIn, clockOut, alcoholCheck };
