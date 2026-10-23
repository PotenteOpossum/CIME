import { Worker } from "node:worker_threads";

// The existing decision engine uses synchronous transactions. Keep that contract
// in its isolated process; a dedicated thread owns the PostgreSQL connection.
// The public platform never runs this adapter on its request-processing thread.
export class PostgresDatabase {
  constructor({ url, schema }) {
    if (!/^cime_(platform|run_[a-f0-9]+)$/.test(schema))
      throw new Error("Invalid database schema");
    this.schema = schema;
    this.buffer = new SharedArrayBuffer(32 * 1024 * 1024);
    this.control = new Int32Array(this.buffer, 0, 4);
    this.bytes = new Uint8Array(this.buffer, 16);
    this.worker = new Worker(new URL("./postgresWorker.js", import.meta.url), {
      workerData: {
        url,
        schema,
        buffer: this.buffer,
        testDirectory:
          process.env.NODE_ENV === "test"
            ? process.env.CIME_PGLITE_TEST_DIR
            : undefined,
      },
      execArgv: process.execArgv.filter(
        (arg) => !arg.startsWith("--input-type"),
      ),
    });
    this.worker.on("error", (error) => {
      console.error("Database worker failed:", error.message);
    });
    this.call("connect");
  }

  call(method, sql, params = []) {
    Atomics.store(this.control, 0, 0);
    this.worker.postMessage({ method, sql, params });
    if (Atomics.wait(this.control, 0, 0, 60000) === "timed-out") {
      // Never allow another request to overwrite a timed-out bridge response.
      this.worker.terminate();
      throw new Error("Database operation timed out; restart this worker");
    }
    const result = JSON.parse(
      new TextDecoder().decode(
        this.bytes.subarray(0, Atomics.load(this.control, 1)),
      ),
    );
    if (result.error) {
      const error = new Error(result.error.message);
      error.code =
        result.error.code === "23505"
          ? "SQLITE_CONSTRAINT_UNIQUE"
          : result.error.code;
      throw error;
    }
    return result;
  }

  pragma() {
    /* SQLite-only pragmas are deliberately ignored. */
  }
  exec(sql) {
    this.call("exec", sql);
  }
  prepare(sql) {
    return {
      all: (...params) => this.call("query", sql, params).rows,
      get: (...params) => this.call("query", sql, params).rows[0],
      run: (...params) => {
        const result = this.call("run", sql, params);
        return {
          changes: result.rowCount,
          lastInsertRowid: result.rows?.[0]?.id || 0,
        };
      },
    };
  }
  transaction(fn) {
    return (...args) => {
      this.exec("BEGIN");
      try {
        const result = fn(...args);
        if (result?.then)
          throw new Error("Engine transactions must be synchronous");
        this.exec("COMMIT");
        return result;
      } catch (error) {
        this.exec("ROLLBACK");
        throw error;
      }
    };
  }
  close() {
    this.worker.terminate();
  }
}
