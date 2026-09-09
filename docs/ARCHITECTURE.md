# Vertex Architecture

## 1. Architectural goals

Vertex should remain simple to reason about, safe around credentials, and deployable as independent Sanity Studio and learner-web workspaces.

Core principles:

- clear server/client boundaries,
- private credentials stay server-side,
- authored content is separate from per-user application state,
- AI/search integration is server-side,
- offline ingestion stays out of the request path,
- canonical runtime contracts live in code.

---

## 2. Workspace boundary

Vertex consists of two standalone workspaces in one repository.

### Studio workspace

Owns:

- Sanity schemas,
- content authoring,
- Studio deployment,
- schema deployment,
- content/config imports,
- TypeGen-related schema workflows.

It does **not** host the learner-facing Next.js application.

### Web workspace

Owns:

- Next.js App Router pages,
- learner-facing UI,
- server-only Sanity reads,
- authenticated write routes,
- Clerk integration,
- search API and result UI,
- server-side Context MCP / LLM integration,
- PostHog browser instrumentation,
- lesson video embeds and seek behavior,
- progress display and mutation flows.

Do not embed Sanity Studio inside the Next.js app.

---

## 3. Trust boundary

The browser is an untrusted client.

The browser may receive:

- public UI data,
- public Clerk configuration,
- public PostHog project key,
- validated search-result structures,
- authenticated user-facing state appropriate for that user.

The browser must never receive:

- Sanity private read/write tokens,
- Clerk secret key,
- private PostHog API credentials,
- MCP credentials,
- LLM/provider secrets,
- server write credentials.

---

## 4. Content read flow

Learner-facing content is read server-side.

Conceptually:

```text
Browser
  ↓ request
Next.js server
  ↓ authenticated/private server data access
Sanity
  ↓ selected content
Next.js render / response
  ↓
Browser
```

Use the project's existing Next.js data-fetching pattern.

Do not add client-side Sanity tokens.

---

## 5. Protected write flow

Learner state such as progress is written through a protected server route.

```text
Browser
  ↓ authenticated request
Next.js server route
  ↓ verify Clerk identity
Validate input
  ↓
Server-side write client
  ↓
Persist learner state
```

Rules:

- trust the authenticated server identity, not a browser-supplied user id,
- validate write payloads,
- keep write credentials server-only,
- keep learner state distinct from authored content.

---

## 6. Search request flow

Search remains server-controlled.

```text
Search UI
  ↓ query
Next.js search route
  ↓
Query interpretation / MCP + LLM
  ↓
Grounded candidate retrieval
  ↓
Deterministic server ranking
  ↓
Canonical Zod validation
  ↓
Paginated structured response
  ↓
Search UI cards
```

The browser does not call the LLM or Sanity Context MCP directly.

See `SEARCH.md` for the search-specific contract.

---

## 7. Video ingestion flow

Video intelligence is generated offline.

```text
Video URL
  ↓
Provider-specific ingestion
  ├─ captions → timestamped transcript chunks
  └─ chapters → timestamped chapter labels
  ↓
Sanity video document
```

This pipeline must not run during learner page or search requests.

See `VIDEO_PIPELINE.md`.

---

## 8. Auth

Authentication is Clerk.

Rules:

- use Clerk's server-side identity mechanisms for protected operations,
- protect server/private routes through the framework's supported server/middleware mechanisms,
- do not substitute client-side hiding for authorization,
- only Clerk's publishable configuration may reach the browser,
- the Clerk secret key remains server-only.

Browsing stays public unless the product explicitly marks a feature private.

---

## 9. Sanity responsibilities

Sanity stores authored learning content and the project-defined state records that the architecture chooses to persist there.

Read access to a private dataset is server-side.

Write operations use a server-only write token.

Sanity Studio is the authoring environment; it is not the learner app's auth system.

---

## 10. Search Context MCP

The Sanity Context MCP is a server-side search integration.

Operational constraints:

- it requires a deployed Studio application; schema-only deployment is not sufficient,
- if the Studio context plugin is incompatible with the installed Sanity major version, do not force-install it,
- manage the Context document through supported alternatives such as import/MCP when necessary,
- keep its credentials and calls server-side.

The Context document is configuration, not the canonical runtime result schema.

---

## 11. LLM boundary

The LLM may help interpret natural-language search and construct grounded retrieval requests.

The LLM is not trusted as an authoritative database.

It must not be the sole authority for:

- existence of content,
- factual content metadata,
- final result ranking,
- timestamps,
- result counts,
- client-facing response structure.

Use grounded data plus deterministic server logic and runtime validation.

---

## 12. Runtime contracts

Zod/TypeScript contracts in the codebase are canonical for server/client data shapes.

Documentation may describe those contracts conceptually but should not become a competing schema definition.

For any model-produced structured output:

```text
model output
  ↓
runtime validation
  ↓ valid
application logic
```

Invalid output should follow an explicit failure/retry/fallback path rather than reaching the UI unchecked.

---

## 13. Analytics boundary

PostHog browser instrumentation may use its public project key.

Any private PostHog administration/API credential remains server-only.

Analytics events represent observed engagement; they must not serve as the canonical state for learner completion or course content.

---

## 14. Environment configuration

Project ids, dataset names, tokens, keys, and provider configuration belong in environment variables or the project's existing secure configuration mechanism.

Maintain `.env.example` as the canonical developer-facing list of required environment-variable names.

Never copy real secrets into:

- source files,
- prompts,
- docs,
- client bundles,
- committed fixtures.

---

## 15. Framework/package guidance

Use the installed stack and existing project patterns.

For Next.js, treat the installed `node_modules/next/dist/docs/` documentation as authoritative for the installed version.

Prefer installed package documentation and existing project patterns for:

- `next-sanity`,
- Portable Text,
- Clerk,
- PostHog,
- Tailwind,
- Vercel AI SDK.

Do not introduce a separate backend framework without an explicit architecture change.

---

## 16. Deployment-sensitive changes

Treat these as architecture-sensitive:

- auth/middleware,
- schema changes,
- migrations,
- environment variables,
- Context MCP configuration,
- search contracts,
- server routes,
- provider integrations,
- production data changes.

They require explicit verification and, when applicable, migration/rollback notes in the implementation prompt.
