# What sending webhooks costs

Hookgres is free and runs in your Postgres, so its cost is the disk the
delivery log uses. Hosted services charge per message, and building it
yourself costs engineering time. This page puts numbers on each, from list
prices checked on **2026-11-10**.

<CostCalculator />

## Cost per month

One endpoint per event, 30 days of history, no fixed IPs. Hookgres is priced
at AWS RDS storage ($0.115 per GB-month).

| Webhooks a month | Hookgres | Hookdeck Outpost | Svix Basic | Build it yourself |
| ---------------- | -------: | ---------------: | ---------: | ----------------: |
| 100,000          |    $0.01 |            $0.50 |        $25 |            $1,320 |
| 1,000,000        |    $0.15 |            $9.50 |       $115 |            $1,320 |
| 10,000,000       |    $1.50 |             $100 |     $1,015 |            $1,321 |
| 30,000,000       |    $4.49 |             $300 |     $3,015 |            $1,324 |
| 100,000,000      |      $15 |           $1,000 |    $10,015 |            $1,335 |

Building it yourself also costs about **$13,200 up front** (4 weeks of an
engineer); the column above is the upkeep after that. The other columns leave
out engineering time: Hookgres still needs a daily
[`cleanup()`](/guides/production#clean-up-old-rows) job and your own settings
page for endpoints, which the hosted services give you as a portal.

## Three years, at 1 million webhooks a month

| Option                     | First year | Three years |
| -------------------------- | ---------: | ----------: |
| Hookgres                   |      $1.79 |       $5.38 |
| Hookdeck Outpost (managed) |       $114 |        $342 |
| Svix Basic                 |     $1,380 |      $4,140 |
| Build it yourself          |    $29,042 |     $60,725 |

When customers need **fixed IPs** to allowlist your webhooks:

| Option                              | Per month | Three years |
| ----------------------------------- | --------: | ----------: |
| Hookgres + your own AWS NAT gateway |       $33 |      $1,188 |
| Hookdeck Outpost + static IP add-on |      $110 |      $3,942 |
| Svix Pro (static IPs start on Pro)  |      $585 |     $21,060 |

See [Fixed IPs and data residency](/guides/ips-and-regions) for how to set up
the NAT gateway or an egress proxy.

## What each option gives you

|                                      | Hookgres                                      | Hookdeck Outpost (managed) | Svix (hosted)                 | Build it yourself |
| ------------------------------------ | --------------------------------------------- | -------------------------- | ----------------------------- | ----------------- |
| Queued in your database transaction  | **Yes**                                       | No, a separate API call    | No, a separate API call       | If you build it   |
| Customer data stays in your database | **Yes**                                       | No                         | No                            | Yes               |
| Delivery log you can query with SQL  | **Yes**                                       | Through their API          | Through their API             | If you build it   |
| Something new to run or sign up for  | **No**, it's an npm package                   | An account                 | An account                    | No                |
| Hosted portal for your customers     | No ([waitlist](https://hookgres.dev/#portal)) | **Yes**, on every plan     | **Yes** (unbranded on Pro)    | If you build it   |
| Languages                            | Node.js only                                  | **Any** (HTTP API)         | **Any** (SDKs, HTTP API)      | Yours             |
| Vendor support                       | No, open source                               | **Yes**                    | **Yes**, 99.9% SLA from Basic | Your team         |
| History kept                         | As long as you choose                         | Not on its pricing page    | 7, 30 or 90 days by plan      | Your choice       |

## Where the others are stronger

- **Svix and Hookdeck** host a customer portal today, work from any language,
  and come with an SLA and a support team. Hookgres is a young open source
  library for Node.js.
- **At low volume, price doesn't decide.** At 100,000 webhooks a month, Svix
  costs $25 and Hookdeck Outpost about $0.50. Pick on the other rows.
- **Svix and Outpost can also be self-hosted**, which keeps data with you,
  but then you run their server and its dependencies next to your app.
- **Hookdeck Outpost** is cheap at every volume and open source (Apache 2.0)
  if you'd rather self-host. Against it, Hookgres's case isn't price: it's
  that webhooks commit with your data and there's no separate service.

## How these numbers are worked out

- **Hookgres:** about 1.3 KB of storage per webhook to one endpoint, measured
  in [Database cost](/guides/database-cost), and counted again for each extra
  endpoint (an overestimate: the payload is stored once). Retry attempts and
  long receiver responses add a little. This assumes a daily
  [`cleanup()`](/guides/production#clean-up-old-rows) that keeps only the
  history you chose; without it rows are never deleted, and at 1 million a
  month you'd hold about 47 GB after three years (about $100 of storage in
  total). Workers run in your app, so they add no servers. Not counted: the
  database load (about 12 webhooks a second at 30 million a month) and the
  WAL, which grows backups and replication.
- **Svix** ([pricing](https://www.svix.com/pricing/)): 50,000 messages
  included, then $0.0001 each. Basic is $20 a month and keeps 30 days; Pro is
  $490 and adds static IPs and 90 days. Svix doesn't say how an event sent to
  several endpoints is billed, so it's counted once per event, the reading
  that makes Svix cheapest.
- **Hookdeck Outpost** ([pricing](https://hookdeck.com/outpost/pricing)):
  first 50,000 free, then $10 per million, counted per delivery to each
  destination; static IPs are $100 a month; the portal is on every managed
  plan. Its pricing page doesn't list how long history is kept, so the
  calculator's "History kept" setting doesn't change Outpost's price. Outpost
  is open source under Apache 2.0.
- **Svix plans** ([pricing](https://www.svix.com/pricing/)): the unbranded
  portal and static IPs start on Pro; the 99.9% uptime SLA starts on Basic.
- **Build it yourself:** 4 weeks to build and 2 days a month to maintain, at
  $3,300 a week: the US median software developer's pay, $133,080
  ([BLS, May 2024](https://www.bls.gov/ooh/computer-and-information-technology/software-developers.htm)),
  plus 30% overhead. For scale, Hookgres's `src/` is about 3,000 lines and
  its `test/` about 3,400 (counted on 2026-11-10). Change these in the
  calculator.
- **Fixed IPs on Hookgres:** an AWS NAT gateway at $0.045 an hour, before
  data processing. If your app already sends traffic through one, it's $0.
- Big customers negotiate. These are list prices, and they change: check the
  vendors' pages before deciding.
