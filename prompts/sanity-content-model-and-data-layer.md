# Sanity content model, standalone Studio, and server-side data layer

## Goal

Implement the Vertex content model from `docs/DATA_MODEL.md` as a standalone Sanity Studio workspace (`studio/`), generate TypeGen types, and add the server-only read client + typed GROQ data layer the learner web app will consume. No pages, no writes, no search, no ingestion.

## Guidance read

- `AGENTS.md` (§2 invariants, §3 how to work, §6 workspaces/stack, §7 content model, §8 video, §10 operational constraints, §12 verification)
- `docs/DATA_MODEL.md` (source of truth for this task), `docs/ARCHITECTURE.md` (§2 workspace boundary, §3 trust boundary, §4 read flow, §9), `docs/PRODUCT.md`, `docs/SEARCH.md` (retrieval fields), `docs/VIDEO_PIPELINE.md` (§4 id normalization)
- `.claude/skills/sanity-best-practices`: `SKILL.md`, `references/nextjs.md`, `project-structure.md`, `schema.md`, `typegen.md`, `studio-structure.md`, `groq.md`
- `.claude/skills/create-agent-with-sanity-context/SKILL.md` + `references/studio-setup.md` (Context document type `sanity.agentContext` is plugin-owned)
- `node_modules/next/dist/docs/01-app/01-getting-started/06-fetching-data.md`, `08-caching.md`, `02-guides/caching-without-cache-components.md`
- `node_modules/@sanity/client/dist/index.d.ts` (fetch supports `next: { revalidate, tags }`, `perspective`, `stega`)

## Code inspected

- Untracked scaffold from `sanity init` (embedded flow): `app/studio/[[...tool]]/page.tsx`, root `sanity.config.ts`, `sanity.cli.ts`, `sanity/{env,structure}.ts`, `sanity/schemaTypes/index.ts` (empty), `sanity/lib/{client,image,live}.ts`
- `package.json` (root now carries `sanity`, `@sanity/vision`, `styled-components`, `next-sanity@13.3.3`, `@sanity/image-url`), `tsconfig.json` (includes `**/*.ts`), `eslint.config.mjs`, `.gitignore` (`.env*` swallows `studio/.env.example`)
- `app/layout.tsx`, `app/page.tsx` (presentational sample courses — untouched), `proxy.ts` (Clerk), `next.config.ts` (no `cacheComponents`)
- Installed: `sanity@5.31.2`, `@sanity/client@7.26.2`, `@sanity/icons@3.8.0`, Node 22.22 (type stripping on), `server-only` present only transitively
- Live project: id `v4lee87n`, dataset `production` (**public**, currently 0 documents); Sanity CLI is logged in

## Decisions / assumptions

1. **Standalone Studio.** AGENTS.md §2/§6 and ARCHITECTURE §2 forbid an embedded Studio. The `sanity init` scaffold is moved to `studio/` (own `package.json`, `sanity.config.ts`, `sanity.cli.ts`, `schemaTypes/`, `structure.ts`); `app/studio/`, root `sanity.config.ts`/`sanity.cli.ts` and `sanity/schemaTypes`, `sanity/structure.ts`, `sanity/lib/live.ts` are removed from the web workspace. Studio-only deps (`sanity`, `@sanity/vision`, `styled-components`) leave the root `package.json`; npm keeps `sanity`/`styled-components` installed as `next-sanity` peers.
2. **Greenfield, no migration.** Dataset has 0 documents, so there is nothing to backfill; rollback = revert the commit and `sanity schemas delete` if the deployed schema manifest should go.
3. **Deterministic ids where the docs require them, generated ids elsewhere.** `video._id = video-<provider>-<safeId>` (DATA_MODEL §11, VIDEO_PIPELINE §4) and `progress._id = progress-<clerkUserId>-<lessonId>` (one doc per learner × lesson: patchable without array juggling, one indexed read per lesson page, one filtered read for My Learning). This deliberately overrides the Sanity skill's "let Sanity generate ids" rule — project docs win (DATA_MODEL §14). Course/lesson/instructor/category use generated ids. Dashes only, no dots (dotted ids are path-namespaced).
4. **Lesson has no parent-course field.** Course context is derived by reverse reference in GROQ (`*[_type=="course" && references(^._id)]`) and module/lesson numbers by array order in `sanity/lib/curriculum.ts`.
5. **Video ↔ lesson link is by normalized URL, not a reference.** Both sides go through `lib/video/provider.ts` (`parseVideoUrl` → provider, providerVideoId, canonicalUrl, documentId). Lesson page/search compute the id from `lesson.videoUrl` and fetch `*[_id == $videoId]`. Conservative normalization (host + provider id only) so two genuinely different videos never merge.
6. **Field shapes chosen where DATA_MODEL leaves them open:** `level` = list (beginner/intermediate/advanced); `priceDisplay`, `studentCountDisplay` = strings (display fields per the doc); `learningOutcomes[].icon` = string (icon name); `lesson.durationSeconds` = number (display derived); `keyPoints` = string[]; `proTip` = text; `resources[].type` = list (article/documentation/code/download/video/other); `instructor.expertise` = string[]; `video.provider` = list (youtube/vimeo/bunny); `video.ingestedAt` datetime; chapters `{startSeconds,label}`, transcriptChunks `{startSeconds,text}` exactly as documented.
7. **Search Context document.** `@sanity/context@0.7.1` supports `sanity ^5` (1.0.0 needs ^6), so the plugin is added to the Studio with `insights: false` and its types surfaced in the custom structure. If peer resolution fails, it is dropped and deferred to the search task. No Context document content is authored here (that is the `dial-your-context` step of the search task).
8. **Read client is server-only.** `import 'server-only'`; token comes from `SANITY_API_READ_TOKEN` (optional while the dataset is public, required once it is made private); `perspective: 'published'`, `stega: false`, CDN on. No `defineLive`/browser token — that would ship a token to the browser (AGENTS.md §2). Caching uses the previous Next model (`next: { revalidate, tags }`) since `cacheComponents` is off; every query is tagged by document type so a webhook can `revalidateTag` later.
9. **Queries project only needed fields.** Video queries never return `transcriptChunks`; only `chapters` (bounded). Progress queries are `userId`-filtered and exist as read helpers only — the write route is a separate (high-risk) task.
10. **TypeGen** runs from the Studio (`schemas extract --enforce-required-fields` + `typegen generate`) scanning `../{app,components,lib,sanity}/**` and emitting `../sanity.types.ts` (committed). `studio/schema.json` is ignored.
11. **Tests**: `node --test` (no new test framework) for URL normalization/id derivation, which DATA_MODEL §11 requires to be "stable and tested".
12. **Not done here:** Studio hosting deploy (`sanity deploy` claims a public hostname — user decision), write client/progress route, ingestion, embeds, seeding content.

## Expected files

- `studio/package.json`, `studio/sanity.config.ts`, `studio/sanity.cli.ts`, `studio/tsconfig.json`, `studio/.env.example`, `studio/structure.ts`
- `studio/schemaTypes/index.ts`, `documents/{course,lesson,instructor,category,video,progress}.ts`, `objects/{module,learning-outcome,resource,chapter,transcript-chunk,block-content}.ts`
- Removed: `app/studio/`, `sanity.config.ts`, `sanity.cli.ts`, `sanity/schemaTypes/`, `sanity/structure.ts`, `sanity/lib/live.ts`
- `sanity/env.ts` (kept), `sanity/lib/client.ts` (server-only), `sanity/lib/fetch.ts`, `sanity/lib/image.ts` (kept), `sanity/lib/curriculum.ts`, `sanity/queries/{courses,lessons,instructors,categories,videos,progress}.ts`, `sanity/queries/fragments.ts`
- `lib/video/provider.ts`, `lib/video/provider.test.ts`
- `sanity.types.ts` (generated), `package.json` (deps + `test`/`typegen` scripts), `tsconfig.json` (exclude studio), `eslint.config.mjs` (ignore studio + generated), `.gitignore`, `.env.example`

## Security

- No token ever reaches the browser: client module is `server-only`; only `NEXT_PUBLIC_SANITY_PROJECT_ID`/`DATASET`/`API_VERSION` are public (needed by the image URL builder).
- Progress reads take `userId` as a parameter; callers must pass the Clerk server identity (documented in the module). Authorization is not this layer's job — it never trusts a browser-supplied id because it is never called from the browser.
- **Flag:** the dataset is public. `progress` documents (Clerk ids + viewing state) would be world-readable to anyone who knows the project id. Make `production` private (plan decision) before the progress write route ships; the read client already supports the token.

## Acceptance criteria

- `studio/`: `npx sanity schemas validate` passes; Studio starts with `npm run dev` and lists Courses, Lessons, Instructors, Categories, Videos (internal), Learner progress (internal), Search Context.
- Schema matches DATA_MODEL §2–§8 field by field; no stored module/lesson numbering; no lesson→course field.
- `sanity.types.ts` generated; all `defineQuery` results typed.
- Web: `npm run lint`, `npx tsc --noEmit`, `npm run build`, `npm test` pass.
- Every query executes against the live dataset without a GROQ error (empty results are fine).
- `parseVideoUrl` returns the same document id for URL variants of the same video and `null` for unsupported/malformed URLs.

## Checks

- `cd studio && npm install && npx sanity schemas validate && npm run typegen`
- `npm install && npm run lint && npx tsc --noEmit && npm run build && npm test`
- `cd studio && npx sanity schemas deploy`
- Live query smoke: run each exported query via the read client against `production`.

## Manual tests

1. `cd studio && npm run dev` → open http://localhost:3333, sign in, create a Course with two modules referencing Lessons; confirm module titles carry no stored numbers and lesson has no course field.
2. Create a Video with `sourceUrl` `https://youtu.be/<id>`; confirm `videoId`/`_id` is `video-youtube-<id>` (initial value derived from URL in Studio).
3. In Vision, run `COURSE_BY_SLUG_QUERY` and `LESSON_BY_SLUG_QUERY` from `sanity/queries` and confirm `course` context resolves for a lesson referenced by a course and is `null` for an orphan lesson.
