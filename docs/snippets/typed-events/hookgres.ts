import { Hookgres } from "hookgres";
import type pg from "pg";
import { schemas } from "./schemas.js";

// Create one instance per process and share it.
export function createHookgres(pool: pg.Pool) {
  return new Hookgres({ pool, schemas });
}

export type AppHookgres = ReturnType<typeof createHookgres>;
