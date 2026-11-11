import { z } from "zod";

// One schema per event type. Hookgres infers send()'s types from these.
export const schemas = {
  "invoice.paid": z.object({ invoiceId: z.string(), amount: z.number() }),
  "invoice.voided": z.object({ invoiceId: z.string() }),
  "customer.created": z.object({ customerId: z.string() }),
};
