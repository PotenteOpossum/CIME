import { parentPort, workerData } from "node:worker_threads";
import pg from "pg";
import { translateSql } from "./translateSql.js";

pg.types.setTypeParser(20, Number);
const control = new Int32Array(workerData.buffer, 0, 4);
const bytes = new Uint8Array(workerData.buffer, 16);
let client;
if (workerData.testDirectory) {
  const { PGlite } = await import("@electric-sql/pglite");
  client = new PGlite(workerData.testDirectory);
  await client.waitReady;
} else
  client = new pg.Client({
    connectionString: workerData.url,
    statement_timeout: 45000,
  });

parentPort.on("message", async ({ method, sql, params }) => {
  let result;
  try {
    if (method === "connect") {
      if (client.connect) await client.connect();
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${workerData.schema}"`);
      await client.query(`SET search_path TO "${workerData.schema}"`);
      result = { rows: [] };
    } else {
      const translated = translateSql(sql, method);
      const query =
        workerData.testDirectory && method === "exec"
          ? await client.exec(translated.sql)
          : await client.query(translated.sql, translated.params || params);
      const last = Array.isArray(query) ? query.at(-1) : query;
      result = {
        rows: last?.rows || [],
        rowCount: last?.rowCount ?? last?.affectedRows ?? 0,
      };
    }
  } catch (error) {
    result = { error: { message: error.message, code: error.code } };
  }
  let encoded = new TextEncoder().encode(JSON.stringify(result));
  if (encoded.length > bytes.length)
    encoded = new TextEncoder().encode(
      JSON.stringify({
        error: {
          message: "Database response exceeds 32 MB; paginate the query",
        },
      }),
    );
  bytes.set(encoded);
  Atomics.store(control, 1, encoded.length);
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
});
