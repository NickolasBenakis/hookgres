// Your customer's server: it marks the invoice paid in their ERP.
import http from "node:http";

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const event = JSON.parse(body);
      console.log(`  acme.com  ${event.type} ${event.data.id}  → marked paid in ERP`);
      res.writeHead(204).end();
    });
  })
  .listen(4000);
