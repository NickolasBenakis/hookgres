import express from "express";
import { payInvoice } from "./invoices.js";

const app = express();
app.use(express.json());

// tenantId comes from the session in the real app; a header stands in here.
app.post("/invoices/:id/pay", async (req, res) => {
  const tenantId = req.header("x-tenant-id");
  if (!tenantId) return void res.status(401).end();
  await payInvoice(req.params.id, tenantId);
  res.status(204).end();
});

app.listen(3000);
