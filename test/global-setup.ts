import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/**
 * Uses DATABASE_URL when set (e.g. a local Postgres); otherwise starts a
 * throwaway Postgres in Docker. Each test file isolates itself in its own schema.
 */
export async function setup(project: TestProject) {
  let url = process.env.DATABASE_URL;
  if (!url) {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    url = container.getConnectionUri();
  }
  project.provide("databaseUrl", url);
}

export async function teardown() {
  await container?.stop();
}
