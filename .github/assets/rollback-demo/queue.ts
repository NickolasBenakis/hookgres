// A plain BullMQ queue on Redis, and a worker that POSTs each job to the customer.
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
export const queue = new Queue("webhooks", { connection });

new Worker(
  "webhooks",
  async (job) => {
    await fetch("http://localhost:4000/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: job.name, data: job.data }),
    });
  },
  { connection },
);
