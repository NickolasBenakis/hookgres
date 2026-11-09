# NestJS

This page adds Hookgres to a NestJS app: a global module that provides one
instance, runs migrations on startup and starts the worker, a transactional
send from a controller, and endpoint management routes for your customers.

```sh
npm install hookgres pg
```

## The Hookgres module

Provide the pool and the Hookgres instance once, from a global module, and
inject them where you need them. If your app already provides a `pg.Pool`,
inject that instead of creating a second one.

The module also ties Hookgres to Nest's lifecycle:

- `onModuleInit` runs `migrate()` before the app starts listening.
- `onApplicationBootstrap` starts the worker.
- `onModuleDestroy` stops it and waits for in-flight webhook requests.
- `onApplicationShutdown` ends the pool, after Nest has closed the HTTP
  server.

```ts
// src/hookgres.module.ts
import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { Hookgres } from "hookgres";
import pg from "pg";

export const PG_POOL = "PG_POOL";

const logger = new Logger("Hookgres");

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => {
        const pool = new pg.Pool({
          connectionString: process.env.DATABASE_URL,
        });
        // A dropped idle connection emits "error" on the pool. Without a
        // listener, it crashes the process. Hookgres only adds one to pools
        // it creates.
        pool.on("error", (error) => logger.error(error));
        return pool;
      },
    },
    {
      provide: Hookgres,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) =>
        new Hookgres({
          pool,
          blockPrivateAddresses: true, // customers choose the URLs; keep them off your network
          onError: (error) => logger.error(error),
        }),
    },
  ],
  exports: [PG_POOL, Hookgres],
})
export class HookgresModule
  implements
    OnModuleInit,
    OnApplicationBootstrap,
    OnModuleDestroy,
    OnApplicationShutdown
{
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly hookgres: Hookgres,
  ) {}

  async onModuleInit() {
    await this.hookgres.migrate();
  }

  onApplicationBootstrap() {
    this.hookgres.start();
  }

  async onModuleDestroy() {
    await this.hookgres.stop();
  }

  async onApplicationShutdown() {
    await this.pool.end();
  }
}
```

Nest only runs the shutdown hooks on `SIGTERM` if you enable them:

```ts
// src/main.ts
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(process.env.PORT ?? 3000);
```

```ts
// src/app.module.ts
import { Module } from "@nestjs/common";
import { HookgresModule } from "./hookgres.module.js";
import { InvoicesController } from "./invoices.controller.js";
import { WebhookEndpointsController } from "./webhook-endpoints.controller.js";

@Module({
  imports: [HookgresModule],
  controllers: [InvoicesController, WebhookEndpointsController],
})
export class AppModule {}
```

`migrate()` is idempotent and takes an advisory lock, so every instance can
run it on startup. If the app's database role can't `CREATE`, run it from a
deploy step instead; see [Migrations](/guides/production#migrations).

To run the worker in a separate process, start it from a second entry point
with `NestFactory.createApplicationContext(AppModule)`, and skip `start()` in
the web process, for example behind an environment variable. See
[Running workers](/guides/workers).

## The tenant

The controllers below take the tenant from the request with a small parameter
decorator. It assumes your auth guard has already put the signed-in user on
the request; adjust the property to wherever your auth keeps the tenant.

```ts
// src/tenant-id.decorator.ts
import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

/** The signed-in user's tenant, set on the request by your auth guard. */
export const TenantId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string =>
    ctx.switchToHttp().getRequest().user.organizationId,
);
```

## Send inside a transaction

Queue the webhook in the same transaction as the change it describes. If the
transaction rolls back, no webhook is sent.

```ts
// src/transaction.ts
import type pg from "pg";

/** Runs `fn` in a transaction and commits only if it doesn't throw. */
export async function transaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {}); // keep the original error
    throw error;
  } finally {
    client.release();
  }
}
```

```ts
// src/invoices.controller.ts
import {
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { Hookgres } from "hookgres";
import pg from "pg";
import { PG_POOL } from "./hookgres.module.js";
import { TenantId } from "./tenant-id.decorator.js";
import { transaction } from "./transaction.js";

@Controller("api/invoices")
export class InvoicesController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly hookgres: Hookgres,
  ) {}

  @Post(":id/pay")
  @HttpCode(200)
  async pay(@Param("id") id: string, @TenantId() tenantId: string) {
    const invoice = await transaction(this.pool, async (client) => {
      const { rows } = await client.query(
        `UPDATE invoices SET status = 'paid'
         WHERE id = $1 AND tenant_id = $2
         RETURNING id, amount`,
        [id, tenantId],
      );
      const invoice = rows[0];
      if (!invoice) return null;
      await this.hookgres.send(
        {
          tenantId,
          eventType: "invoice.paid",
          payload: { invoiceId: invoice.id, amount: invoice.amount },
          idempotencyKey: `invoice.paid:${invoice.id}`,
        },
        { client },
      );
      return invoice;
    });
    if (!invoice) throw new NotFoundException();
    return { id: invoice.id, status: "paid" };
  }
}
```

The `idempotencyKey` means paying the same invoice twice queues one webhook.
With Prisma, pass `fromPrisma(tx)` from `hookgres/prisma` as `client`; with
TypeORM or another ORM, pass the transaction's underlying `pg` client. See
[Sending webhooks](/guides/sending#using-an-orm).

## Endpoint management routes

These routes let a customer manage their own endpoints from your settings
page. Two rules keep tenants apart:

- `tenantId` comes from the session (`@TenantId()`), never from the request
  body or URL.
- Hookgres looks endpoints up by id alone, so every route that takes an id
  loads the endpoint with `getEndpoint()` and checks its `tenantId` first. A
  mismatch answers `404`, the same as a missing endpoint.

The secret is returned once, when the endpoint is created or its secret is
rotated, and never in lists.

```ts
// src/webhook-endpoints.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import {
  type Endpoint,
  Hookgres,
  HookgresValidationError,
} from "hookgres";
import { TenantId } from "./tenant-id.decorator.js";

interface CreateEndpointBody {
  url: string;
  description?: string;
  eventTypes?: string[] | null;
}

interface UpdateEndpointBody {
  url?: string;
  description?: string | null;
  eventTypes?: string[] | null;
  disabled?: boolean;
}

/** The endpoint's tenant-facing fields. Leaves out the secret. */
function view(endpoint: Endpoint) {
  return {
    id: endpoint.id,
    url: endpoint.url,
    description: endpoint.description,
    eventTypes: endpoint.eventTypes,
    disabled: endpoint.disabled,
    disabledReason: endpoint.disabledReason,
    createdAt: endpoint.createdAt,
  };
}

@Controller("api/webhook-endpoints")
export class WebhookEndpointsController {
  constructor(private readonly hookgres: Hookgres) {}

  /** The endpoint if it belongs to the tenant. Throws 404 otherwise. */
  private async ownEndpoint(id: string, tenantId: string) {
    const endpoint = await this.hookgres.getEndpoint(id);
    if (endpoint?.tenantId !== tenantId) throw new NotFoundException();
    return endpoint;
  }

  @Get()
  async list(@TenantId() tenantId: string) {
    const endpoints = await this.hookgres.listEndpoints(tenantId);
    return endpoints.map(view);
  }

  @Post()
  async create(
    @TenantId() tenantId: string,
    @Body() body: CreateEndpointBody,
  ) {
    let endpoint: Endpoint;
    try {
      endpoint = await this.hookgres.createEndpoint({
        tenantId,
        url: body.url,
        description: body.description,
        eventTypes: body.eventTypes ?? null,
      });
    } catch (error) {
      if (!(error instanceof HookgresValidationError)) throw error;
      throw new BadRequestException(error.message);
    }
    return { ...view(endpoint), secret: endpoint.secret };
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @TenantId() tenantId: string,
    @Body() body: UpdateEndpointBody,
  ) {
    const endpoint = await this.ownEndpoint(id, tenantId);
    try {
      const updated = await this.hookgres.updateEndpoint(endpoint.id, {
        url: body.url,
        description: body.description,
        eventTypes: body.eventTypes,
        disabled: body.disabled,
      });
      return updated && view(updated);
    } catch (error) {
      if (!(error instanceof HookgresValidationError)) throw error;
      throw new BadRequestException(error.message);
    }
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string, @TenantId() tenantId: string) {
    const endpoint = await this.ownEndpoint(id, tenantId);
    await this.hookgres.deleteEndpoint(endpoint.id);
  }

  @Post(":id/rotate-secret")
  @HttpCode(200)
  async rotateSecret(@Param("id") id: string, @TenantId() tenantId: string) {
    const endpoint = await this.ownEndpoint(id, tenantId);
    const rotated = await this.hookgres.rotateEndpointSecret(endpoint.id);
    return { secret: rotated?.secret };
  }
}
```

`createEndpoint()` and `updateEndpoint()` throw for an invalid or blocked URL
and for an invalid `eventTypes` array with a `HookgresValidationError`, which
these routes return as `400` with its message. Any other error, such as a
database error, is rethrown and becomes a `500`.
Validate the bodies with `ValidationPipe` and DTO classes as usual; the
interfaces here only give them types. Only the fields you pass to
`updateEndpoint()` change; `undefined` ones are left alone. After a rotation,
Hookgres signs with both the old and new secret for 24 hours; see
[Secret rotation](/guides/secret-rotation).

## Receiving webhooks

Verification needs the raw request body. Create the app with
`NestFactory.create(AppModule, { rawBody: true })`, then pass `req.rawBody`
to `verifyWebhook()`:

```ts
@Post("webhooks")
@HttpCode(204)
receive(@Req() req: RawBodyRequest<Request>) {
  try {
    const event = verifyWebhook({
      secret,
      headers: req.headers,
      body: req.rawBody!,
    });
    // handle event.type and event.data
  } catch {
    throw new BadRequestException("invalid signature");
  }
}
```

`Request` here is Express's. See [Verifying webhooks](/guides/verifying) for
deduplication and how quickly to respond.
