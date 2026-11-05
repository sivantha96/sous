# Lens: specs and safety

Check the change against the primary specs and the runtime it lands in, not only against this repo's docs. Read the spec itself (an RFC, the OpenAPI or JSON Schema spec, ULID, CloudEvents, the HTTP spec, the database manual, the SDK's docs) and link it.

- **Formats and protocols.** Ids, timestamps, headers, status codes, content types, event envelopes and schema fields match their spec: lengths, ranges, character sets, required fields and names. A regex or validator that accepts a value the spec forbids is a finding; give the value.
- **API description.** Generated API documents carry what client generators and test tools need (operation ids, error responses, examples) and agree with the code.
- **Database and migrations.** Locks and timeouts on schema changes, statements that can't run in a transaction, migrations treated as applied by name while their content can change, grants that miss views or new tables, row-level security checks that accept any policy, column types that don't match the id or money format.
- **Startup and shutdown order.** Telemetry, tracing and error reporting set up in the order their SDKs require, and flushed on shutdown. Two libraries that both register a global provider.
- **Volume under failure.** What one outage does: one error event, alert or log line per request, retries that multiply load, queues that grow without bound.
- **Configuration source of truth.** A setting read from a different variable than the one infra sets or alerts filter on.
- **Weight.** A dependency or image layer that pulls in far more than the code uses: give the size or package count.

Each finding names the spec section or SDK doc and the input that breaks.
