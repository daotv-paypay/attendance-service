require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function run() {
  console.log("Start full aggregation...");

  await pool.query(`TRUNCATE attendance_daily RESTART IDENTITY`);

  await pool.query(`
    INSERT INTO attendance_daily
    (
      user_id,
      work_date,
      check_in,
      check_out,
      created_at,
      updated_at
    )
    SELECT
      user_id,
      work_date,
      check_in,
      check_out,
      work_date,
      work_date
    FROM (
        SELECT
          user_id,
          DATE(record_time) AS work_date,
          MIN(record_time) AS check_in,
          CASE 
            WHEN COUNT(*) >= 2 THEN MAX(record_time)
            ELSE NULL
          END AS check_out
        FROM attendance_logs
        GROUP BY user_id, DATE(record_time)
    ) t
    ORDER BY work_date
  `);

  console.log("Aggregation done");

  process.exit();
}

run();
