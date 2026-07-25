# Documentation

Docs for the containerized, API-driven Super Productivity setup.

- **[super-productivity-explainer.md](./super-productivity-explainer.md)** — what
  the stack is, how the container owns the data, and the model you need before
  calling the API (op-log sync, tag-driven boards, the Today list). Also covers
  signing in, accounts and per-user boards, working on the app without a
  7-minute image rebuild, the operational gotchas, and what this fork removed
  from upstream and why.
- **[api-reference.md](./api-reference.md)** — the complete REST contract: all 40
  endpoints with parameters, examples, and the MCP tool each one replaces.

New here? Read the explainer first, then keep the reference open.

## A convention these docs follow

Everything here describes what the stack **does today**. Design intent that is
not yet implemented is called out inline as a blockquote beginning **"Not true
yet."**, naming what falls short and why.

This exists because it was got wrong: the explainer described the intended
end-state of container authority in the present tense, so a design goal read as
shipped behaviour — and the gap it hid (browsers holding data they had no claim
on) went unnoticed for as long as the doc kept asserting otherwise. If a claim
here cannot be pointed at in code, it belongs in one of those blockquotes.
