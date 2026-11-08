/**
 * Ordered, append-only schema migrations. Never edit a shipped entry; add a
 * new one. `{{schema}}` is replaced with the quoted schema name.
 */
export const migrations: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE {{schema}}.endpoints (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  url text NOT NULL,
  description text,
  event_types text[],
  secret text NOT NULL,
  previous_secret text,
  previous_secret_expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  disabled boolean NOT NULL DEFAULT false,
  disabled_reason text,
  failing_since timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX endpoints_tenant_idx ON {{schema}}.endpoints (tenant_id);

CREATE TABLE {{schema}}.messages (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_tenant_created_idx ON {{schema}}.messages (tenant_id, created_at DESC);
CREATE UNIQUE INDEX messages_idempotency_idx
  ON {{schema}}.messages (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE {{schema}}.deliveries (
  id text PRIMARY KEY DEFAULT 'dlv_' || replace(gen_random_uuid()::text, '-', ''),
  message_id text NOT NULL REFERENCES {{schema}}.messages (id) ON DELETE CASCADE,
  endpoint_id text NOT NULL REFERENCES {{schema}}.endpoints (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'succeeded', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  lock_token uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_due_idx ON {{schema}}.deliveries (next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX deliveries_locked_idx ON {{schema}}.deliveries (locked_until)
  WHERE status = 'delivering';
CREATE INDEX deliveries_message_idx ON {{schema}}.deliveries (message_id);
CREATE INDEX deliveries_endpoint_idx ON {{schema}}.deliveries (endpoint_id, created_at DESC);

CREATE TABLE {{schema}}.attempts (
  id text PRIMARY KEY DEFAULT 'att_' || replace(gen_random_uuid()::text, '-', ''),
  delivery_id text NOT NULL REFERENCES {{schema}}.deliveries (id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  status_code integer,
  response_body text,
  error text,
  duration_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attempts_delivery_idx ON {{schema}}.attempts (delivery_id, created_at);
`,
  },
];
