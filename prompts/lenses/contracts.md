# Lens: contracts and old clients

Anything another party depends on: published API shapes, status codes, error format, event payloads, database schema, env vars, shared package exports. Old app versions that cannot be forced to upgrade. A required field added to a request, a field removed or renamed in a response, a new enum value an old client cannot parse. Use the cross-repo impact list in the context file, and name each dependent that breaks.

Only these categories; anything else belongs to another lens.
