// Your customer's server. It verifies every request and is down for the first two.
import http from "node:http";
import { verifyWebhook } from "hookgres";

let requests = 0;
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const event = verifyWebhook({ secret: process.env.WEBHOOK_SECRET!, headers: req.headers, body });
      const status = ++requests <= 2 ? 503 : 204;
      console.log(`  acme.com  ${event.type} ${JSON.stringify(event.data)}  signature ok  → ${status}`);
      res.writeHead(status).end();
    });
  })
  .listen(4000);
