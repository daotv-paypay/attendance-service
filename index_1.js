require("dotenv").config();
const ZKLib = require("zkteco-js");
const { Pool } = require("pg");

/* =========================
   CONFIG
========================= */

const DEVICE_IP = process.env.DEVICE_IP;
const DEVICE_PORT = parseInt(process.env.DEVICE_PORT);

const SYNC_INTERVAL = 60000; // 1 phút
const AGG_INTERVAL = 300000; // 5 phút

/* =========================
   TELEGRAM
========================= */

async function sendTelegram(message) {
  try {
    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: message,
        }),
      },
    );
  } catch (err) {
    console.log("Telegram error:", err.message);
  }
}

/* =========================
   DEVICE
========================= */

const device = new ZKLib(DEVICE_IP, DEVICE_PORT, 10000, 4000);
let isDeviceConnected = false;

/* =========================
   DB
========================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/* =========================
   UTILS
========================= */

function toUTC(dateStr) {
  const d = new Date(dateStr);
  d.setHours(d.getHours() - 7);
  return d;
}

/* =========================
   CONNECT DEVICE
========================= */

async function connectDevice() {
  try {
    console.log("Connecting to device...");
    await device.createSocket();
    isDeviceConnected = true;
    console.log("Device connected");
  } catch (err) {
    console.log("Device connect failed:", err.message);
    isDeviceConnected = false;
    setTimeout(connectDevice, 5000);
  }
}

/* =========================
   LAST SN
========================= */

async function getLastSn() {
  const { rows } = await pool.query(
    `SELECT last_sn FROM device_sync_state WHERE device_ip = $1`,
    [DEVICE_IP],
  );

  if (!rows.length) return 0;
  return rows[0].last_sn;
}

async function updateLastSn(sn) {
  await pool.query(
    `INSERT INTO device_sync_state (device_ip, last_sn)
     VALUES ($1,$2)
     ON CONFLICT (device_ip)
     DO UPDATE SET
       last_sn = EXCLUDED.last_sn,
       updated_at = NOW()`,
    [DEVICE_IP, sn],
  );
}

/* =========================
   SYNC ATTENDANCE
========================= */

async function syncAttendance() {
  if (!isDeviceConnected) return;

  try {
    const result = await device.getAttendances();
    if (!result || !result.data) return;

    const logs = result.data;
    const lastSn = await getLastSn();

    let maxSn = lastSn;

    const newLogs = logs.filter((log) => log.sn > lastSn && log.user_id);

    console.log("Total logs:", logs.length);
    console.log("Last SN:", lastSn);
    console.log("New logs:", newLogs.length);

    if (!newLogs.length) return;

    const values = [];
    const placeholders = [];
    let index = 1;

    for (const log of newLogs) {
      const recordTimeUTC = toUTC(log.record_time);

      values.push(
        log.sn,
        log.user_id,
        recordTimeUTC,
        log.type,
        log.state,
        log.ip,
      );

      placeholders.push(
        `($${index++},$${index++},$${index++},$${index++},$${index++},$${index++})`,
      );

      if (log.sn > maxSn) maxSn = log.sn;
    }

    await pool.query(
      `INSERT INTO attendance_logs
      (device_sn,user_id,record_time,verify_type,status,device_ip)
      VALUES ${placeholders.join(",")}
      ON CONFLICT (device_ip,device_sn) DO NOTHING`,
      values,
    );

    await updateLastSn(maxSn);

    console.log("Sync completed. last_sn =", maxSn);
  } catch (err) {
    console.log("Sync error:", err.message);
    isDeviceConnected = false;
    connectDevice();
  }
}

/* =========================
   AGGREGATE DAILY
========================= */

async function aggregateDaily() {
  try {
    await pool.query(`
      INSERT INTO attendance_daily
      (user_id, work_date, check_in, check_out)

      SELECT
        user_id,
        work_date,
        MIN(record_time) AS check_in,
        CASE
          WHEN COUNT(*) > 1 THEN MAX(record_time)
          ELSE NULL
        END AS check_out

      FROM (
        SELECT
          user_id,
          record_time,
          (record_time AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS work_date
        FROM attendance_logs
      ) t

      WHERE work_date = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date

      GROUP BY user_id, work_date

      ON CONFLICT (user_id, work_date)
      DO UPDATE SET
        check_in = LEAST(attendance_daily.check_in, EXCLUDED.check_in),
        check_out = GREATEST(attendance_daily.check_out, EXCLUDED.check_out),
        updated_at = NOW()
    `);

    console.log("Daily attendance aggregated");
  } catch (err) {
    console.log("Aggregate error:", err.message);
  }
}

/* =========================
   NOTIFY JOBS
========================= */

let lastRunCheckIn = null;
let lastRunCheckOut = null;

async function notifyNoCheckInOrLate() {
  try {
    const { rows } = await pool.query(`
      SELECT u."fullName"
      FROM users u
      LEFT JOIN attendance_daily a
        ON u.code = a.user_id
        AND a.work_date = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
      WHERE
        u.active = true
        AND u.code IS NOT NULL
        AND u.code <> ''
        AND (
          a.check_in IS NULL
          OR (a.check_in AT TIME ZONE 'Asia/Ho_Chi_Minh')::time > '09:05:59'
        )
    `);

    if (!rows.length) return;

    const list = rows.map((r) => `- ${r.fullName}`).join("\n");

    await sendTelegram(`🚨 Chưa check-in / đi muộn:\n${list}`);

    console.log("Notify check-in sent");
  } catch (err) {
    console.log("Notify error:", err.message);
  }
}

async function notifyNoCheckOut() {
  try {
    const { rows } = await pool.query(`
      SELECT u."fullName"
      FROM users u
      LEFT JOIN attendance_daily a
        ON u.code = a.user_id
        AND a.work_date = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
      WHERE
        u.active = true
        AND u.code IS NOT NULL
        AND u.code <> ''
        AND a.user_id IS NOT NULL
        AND a.check_out IS NULL
    `);

    if (!rows.length) return;

    const list = rows.map((r) => `- ${r.fullName}`).join("\n");

    await sendTelegram(`⚠️ Chưa checkout:\n${list}`);

    console.log("Notify checkout sent");
  } catch (err) {
    console.log("Notify error:", err.message);
  }
}

/* =========================
   SCHEDULER
========================= */

function scheduleJobs() {
  setInterval(() => {
    const now = new Date();

    const vn = new Date(
      now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }),
    );

    const hour = vn.getHours();
    const minute = vn.getMinutes();
    const todayKey = vn.toDateString();

    // 12:00
    if (hour === 9 && minute === 15 && lastRunCheckIn !== todayKey) {
      lastRunCheckIn = todayKey;
      notifyNoCheckInOrLate();
    }

    // 18:05
    if (hour === 18 && minute === 10 && lastRunCheckOut !== todayKey) {
      lastRunCheckOut = todayKey;
      notifyNoCheckOut();
    }
  }, 60000);
}

/* =========================
   START
========================= */

async function start() {
  console.log("Attendance Service Started");

  await connectDevice();

  setInterval(syncAttendance, SYNC_INTERVAL);
  setInterval(aggregateDaily, AGG_INTERVAL);

  scheduleJobs();
}

start();
