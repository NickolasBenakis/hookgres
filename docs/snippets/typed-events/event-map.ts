import { Hookgres } from "hookgres";
import type pg from "pg";

// Compile-time checks only: nothing is validated at runtime.
export type Events = {
  "invoice.paid": { invoiceId: string; amount: number };
  "invoice.voided": { invoiceId: string };
};

export function createHookgres(pool: pg.Pool) {
  return new Hookgres<Events>({ pool });
}
