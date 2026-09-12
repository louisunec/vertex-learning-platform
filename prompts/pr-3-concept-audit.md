# PR-3 concept audit: pilot course dry runs

Runs on 2026-09-12 with `concept-extraction-v1` / `spans-12-concepts-2-v1`, `concept-prerequisites-v1` / `concepts-60-evidence-1-edges-80-v1`, `gpt-5-mini`, reasoning effort medium.

**Nothing was written to Sanity.** Every run used `--dry-run`, and `SANITY_API_WRITE_TOKEN` is unset. Outputs are in the session scratchpad and are not committed.

## 1. Canary: `extract --course practical-web-security --limit 2 --dry-run`

- **Calls and candidates:** 8 spans and 8 model calls, with 0 failures. They produced 16 candidates, 0 rejected.
- **Clusters:** 13, giving 13 concept drafts.
  - `Authorization (roles & permissions)` joined `Authorization` through an alias.
  - `SQL injection` joined across spans.
- **Sample review (4 drafts):**
  - Summaries are accurate and read as standalone text.
  - Objectives start with a verb and are assessable.
  - Some aliases are broader or narrower than the concept, although the prompt forbids it:
    - `SQL injection` got the broader "injection attack";
    - `Authorization` got the narrower "RBAC" and "Role-based access control".
  - Near-duplicate objectives survive, because deduplication is exact-match only.
  - "Common authentication methods (overview)" and "OWASP Top 10" are topics, not skills.

## 2. Prerequisites over the canary concepts: `prerequisites --dry-run --concepts-from <canary>`

- 13 concepts, 1 model call. The call used 1,778 input and 2,933 output tokens and took 43 s.
- **5 edges proposed**, with 0 rejections and 0 cycles:
  - authentication → authorization
  - authorization → broken access control
  - authentication → common authentication methods
  - common authentication methods → broken authentication
  - SQL injection → prepared statements
- **Sample review.** All five describe a genuine dependency, not course order. The rationales are specific, and evidence was drawn from an endpoint's chunk. The set is conservative: nothing crosses unrelated topics.

## 3. Full course: `extract --course practical-web-security --dry-run`

- **Spans:** 63 spans and 63 model calls, with 0 failures.
  - 62 spans extracted candidates.
  - 1 returned no candidates: the secrets-management outro ("likes/subscriptions"), which the model skipped correctly.
- **Candidates:** 121, none rejected.
- **Clusters:** 88, giving **88 concept drafts**.
  - Only 5 concepts span more than one lesson: SQL injection, parameterized queries, XSS, CSP, and session-based cookie authentication.
  - Each lesson has 3–12 concepts.
  - 29 source refs were dropped by the 8-ref cap. Every lesson that cites a concept is still represented.
- **The prerequisite step refuses the full set, as designed.** 88 is above the 60-concept bound of one call, so the step made 0 model calls and exited 1.

### Findings (these need a decision before any concept is published)

1. **The set is too fine-grained for "a small pilot concept set".** Many drafts are facts or facets rather than assessable skills:
   - "Breaking-change warnings in SCA fixes"
   - "Marking variables as sensitive"
   - "Risk reduction from least privilege"
   - "CSP 'none' source expression"
2. **Lexical matching misses synonyms, as expected.**
   - "Authorization (access control)" and "Authorization (roles and permissions)" are separate drafts in this run. The canary joined them only because the model happened to emit an overlapping alias, and runs are not deterministic.
   - At least 4 CSRF drafts are near-duplicates:
     - "…risk for cookie-authenticated actions"
     - "CSRF risk with session-based auth…"
     - "Automatic cookie sending enabling CSRF"
     - the token pair
   - Three drafts cover least privilege.
3. **Some aliases are not synonyms.** "Sessions vs JWTs" became an alias of session-based cookie authentication. Wrong aliases can join unrelated concepts on a later run.

These are failures of the kind the review checks exist for (`notDuplicate`, `granularityAppropriate`), but 88 drafts is a heavy review load for the pilot. Options, none implemented:

- **(a)** Review and prune to a small approved set (≤60, likely 20–30), then run `prerequisites` on the published set.
- **(b)** Prompt v2: at most 1 concept per span, a stronger "skill, not fact" rule, and aliases restricted to abbreviations and spellings. This bumps `CONCEPT_EXTRACTION_PROMPT_VERSION`.
- **(c)** Match names with their trailing parenthetical qualifier removed, which joins "Authorization (…)" variants. This changes the approved normalization rule.
- **(d)** Split the prerequisite call per module or with sliding windows. This changes the bounded-call design.

## Idempotency and write-safety checks (unit tests)

These properties were covered by unit tests (`lib/concepts/*.test.ts`, 58 tests), not by the live dry runs:
- record-based reruns make 0 model calls and write nothing;
- failed calls are not recorded;
- the run cap defers;
- published concepts and edges are never written;
- editor-changed drafts are left alone;
- rejected pairs are never re-proposed (the v1 rule, replaced in v2 by versioned suppression; see below);
- `--force` deletes only unedited, unreproduced drafts of this course.

---

# v2: extraction v2 and course-level consolidation

This section covers the dry runs of 2026-09-12 with `concept-extraction-v2` / `spans-12-primary-1-secondary-1-v2`, `concept-consolidation-v1` / `concepts-120-evidence-1-groups-40-v1` and `concept-prerequisites-v1`, all on `gpt-5-mini` with medium reasoning effort. The approved plan is `prompts/pr-3-consolidation.md`.

**Nothing was written to Sanity.** Every run used `--dry-run`, and `SANITY_API_WRITE_TOKEN` is unset.

## Canary: `extract --limit 2`, then `consolidate`, then `prerequisites`

- **Extraction:** 8 spans and 8 model calls, with 0 failures.
  - 12 candidates: 7 primary, 5 secondary. None was rejected, and the model excluded 47 details.
  - 10 concepts, down from 13 in v1.
  - Most secondaries are individual OWASP risks from the overview lesson, which are independently testable.
- **Consolidation:** 0 groups. The model found no duplicates among distinct OWASP items, which is correct.
- **Prerequisites:** 3 edges, all genuine dependencies:
  - authentication → authorization
  - authentication → broken authentication
  - authorization → broken access control

## Full course: `extract --course practical-web-security --dry-run`

| Metric | v1 | v2 |
| --- | --- | --- |
| Model calls, failures | 63, 0 | 63, 0 |
| Candidates | 121 | **80** (61 primary, 19 secondary) |
| Rejected candidates | 0 | 1 (`field_too_long:summary`) |
| Facts/details excluded by the model | — | **339** |
| Incidental details rejected (deterministic) | — | 0; the model now leaves them out itself |
| Aliases dropped by the alias filter | — | 0 |
| Lexical duplicate groups (clusters with >1 candidate) | — | **16** |
| Concepts | 88 | **55** (41 primary, 14 secondary-only) |
| Concepts spanning more than one lesson | 5 | 5 |

Examples of what the model excluded: example usernames ('naveen'), the literal payload '1=1', a sample SQL query, "references to Java or PHP", and "Instruction to Google 'owasp top 10'".

## Consolidation over the 55 v2 concepts

- One call: 6,907 input and 3,215 output tokens, 40 s.
- **5 merge proposals** (all `facets`):
  - Authentication methods ⇐ Federated authentication, JSON Web Tokens, Server-side sessions
  - Properties of cryptographic hash functions ⇐ Collision resistance
  - Cross-Site Request Forgery (CSRF) mechanism ⇐ CSRF tokens
  - Cross-site scripting ⇐ Reflected cross-site scripting, Stored cross-site scripting
  - Parameterized queries ⇐ Execution plan reuse
- **3 groups rejected** (`index_out_of_range`). The model added one invented member index (`k3714`, `k533`, `k5151`) to otherwise plausible groups: password storage (5 members), HTTP security headers (5) and SCA (5). Validation rejects a whole group rather than repairing it. If those groups had been valid, the estimate would fall by about 12 more.
- **Estimated count after proposed merges: 55 → 47**, within the 40–60 target. This is the hypothetical set with all 5 proposals accepted: 36 primary and 11 secondary-only concepts.
- **Precision concerns:**
  - "CSRF tokens" folded into the CSRF mechanism merges a mitigation into its attack, despite the prompt rule.
  - "JSON Web Tokens" under "Authentication methods" is arguable.
  - Editors decide each proposal.

## Prerequisites over the hypothetical 47

- One call: 5,349 input and 5,629 output tokens, 73 s.
- **28 edges proposed**, with 0 rejections and 0 cycles.
- **Most are genuine.** Examples:
  - SQL injection → parameterized queries
  - transitive dependencies → SCA / SBOM
  - password hashing → salting
  - authorization → broken access control
- **Review items:**
  - "password salting → password hashing and salting": a duplicate pair the consolidation missed.
  - "CORS → CSRF mechanism": weak.
  - "secrets-management best practices → sensitive data exposure": direction or relevance is questionable.
  - "SCA → using components with known vulnerabilities": direction is questionable.

## Item 6: fixed input (the v1 88 drafts), two consolidation runs

| Criterion | Run 1 | Run 2 |
| --- | --- | --- |
| Both Authorization drafts share a group | ✓ (`duplicate`) | ✓ (`duplicate`) |
| All 3 CSRF-risk drafts share a group | ✗: "Automatic cookie sending enabling CSRF" was not grouped | ✓ |
| Both CSRF-token drafts share a group | ✓ | ✓ |
| At least 4 CSRF drafts are merge candidates | ✓ (6 of 7) | ✓ (6 of 7) |
| Estimate | 88 → 47 | 88 → 49 |

- Both runs also merged a mitigation into its attack (tokens into CSRF risk; sanitization into XSS) and folded independent headers into "HTTP security headers". Recall of real duplicates is good; precision needs editor review.
- One group per run was rejected by validation (`canonical_not_member` in run 1, `evidence_not_from_members` in run 2).
- In the v2 extraction itself, the CSRF and Authorization duplicates no longer appear:
  - CSRF resolves to 2 concepts (mechanism, tokens);
  - Authorization resolves to one "Authorization" plus a comparison concept, "Authentication vs Authorization".

## Deterministic sample: 10 concepts (lowest sha256 of `conceptId`, from the hypothetical 47)

Each sample has an accurate summary and cites real transcript evidence:
- Server-side input sanitization
- OAuth 2 authorization code flow
- HashiCorp Vault integration with Terraform
- Dependency reachability analysis
- Principle of least privilege
- Software supply chain risk
- XML External Entity
- Software Bill of Materials
- Dictionary attacks and rainbow tables
- Content Security Policy (2 lessons, 6 candidates)

Issues found in the sample:
- **Loose aliases:** "OAuth 2.0 access and refresh tokens" on the auth-code flow; "script-src" on CSP; "access control principle" on least privilege. The alias backstop is lexical and misses these.
- **A secondary concept that is a mitigation:** "Server-side input sanitization" is independently testable and correctly kept separate from XSS.

The full sample text with evidence is in the scratchpad file `v2-full-consolidate.json`; it is not committed.

---

# Final correction: equivalence-only merges (2026-09-13)

This section covers the approved plan `prompts/pr-3-equivalence-merges.md`. The 55-concept v2 extraction was kept, and no extraction was rerun.

- **Model calls:** two, `consolidate` and `prerequisites`.
- **Writes:** only to the throwaway dataset `pr3-smoke`. It is private, was seeded from a read-only export of production content plus the 63 v2 records, and was deleted afterwards.
- **Production:** nothing was written. After the run, production still had 0 concept, proposal and record documents.

## Re-projection of the 55 concepts (0 model calls)

- The same 55 concept ids come out, and names, summaries, objectives and references are unchanged.
- Aliases go from 98 to 92. The dropped aliases are:
  - `script-src` and `Content Security Policy script-src` (CSP now has only `CSP`);
  - `strict-origin-when-cross-origin`;
  - `OAuth 2.0 access and refresh tokens`;
  - `Software composition analysis (SCA) tools`;
  - `One-way password hashing`.
- The `script-src` directive stays in CSP's objectives and evidence.

## Consolidation v2 over the 55 (`concept-consolidation-v2`, one call)

- One call: 6,911 input and 3,438 output tokens, 41 s.
- **1 proposal:** "Password salting" is the same concept as "Password hashing and salting". This is the duplicate the v1 run missed. The estimate goes from 55 to 54.
- **3 groups rejected by the server:**
  - CSRF mechanism with CSRF tokens: `not_equivalent:attack_and_defence`;
  - hash-function properties with collision resistance: `not_equivalent:subtopic`;
  - HTTP security headers with 5 headers: `not_equivalent:subtopic`.
- The 5 `facets` proposals of the previous run are the kind of group this version rejects.

## Prerequisites over the 55 unmerged concepts (dry run, one call)

- One call: 6,171 input and 8,011 output tokens, 94 s.
- **38 edges proposed**, with 0 rejected and 0 cycles. Every edge would be a `proposed` draft pending review. Nothing was written.
- **Doubtful edges, 12 in total:**
  - **Between the duplicate pair.**
    - password salting → password hashing and salting: disappears if the merge is accepted (it would be a self-loop);
    - password hashing → password hashing and salting: survives the merge as the combined concept's edge.
  - **Hierarchy, not dependency.** A parent is not needed to learn its part:
    - HTTP security headers → CSP, HSTS, Permissions Policy, Referrer-Policy and X-Content-Type-Options (5 edges)
    - password storage methods → plaintext storage
    - password storage methods → reversible encryption risks
  - **Direction or relevance:**
    - federated authentication → OAuth 2 authorization code flow: probably reversed
    - CVE → using components with known vulnerabilities: weak
    - Terraform tfvars → Terraform environment variables: siblings

## Studio smoke test (`pr3-smoke`, local `sanity dev`)

- **Setup:** an isolated Chrome profile with default security. The user signed in normally, and the checks were driven over the Chrome debugging port with `playwright-core` from the scratchpad.
- **Results:**

  | Check | Result |
  | --- | --- |
  | 55 concepts listed; production has 0 | ✓ |
  | Publish on a `needs_review` concept is disabled with the gate message; still disabled with only the checks ticked; enabled after Approved plus every check; publish succeeds | ✓ |
  | Concept actions: no delete, unpublish or duplicate | ✓ |
  | Proposal: no publish, delete, duplicate or unpublish | ✗ at first: "Schedule publish" and "Discard changes" were present (see below) |
  | Reject, then `extract`: 54 unchanged, CSP left as published, 0 writes, 0 deletes | ✓ |
  | Accept, then `extract`: merge applied, 1 absorbed draft deleted | ✓ |
  | Reject the applied proposal, then `extract`: "Password salting" restored under its original id; both drafts identical to the originals apart from `generatedAt`; 0 conflicts | ✓ |

- **Finding, fixed with approval:**
  - "Schedule publish" publishes later without the review gate. It was available on concepts, edges and assessments.
  - "Discard changes" on a never-published document deletes it. That could remove a rejected concept or a proposal kept for audit.
  - Now "Schedule publish" is removed from gated types and proposals. "Discard changes" is removed from proposals and disabled on never-published concepts and edges.
  - Re-checked in the Studio: a concept draft shows only a gated Publish and a disabled Discard, and a proposal shows no actions while its status stays editable.

## Remaining review limitations

- The publish gates are client-side Studio document actions. A Releases workflow and direct API writes are not gated.
- The model may still label a sub-topic as `same_concept`. Editors decide every proposal.
- Between accepting a merge and rejecting it later, absorbed members are absent until the next `extract` run restores them.
- Prerequisite edges were not exercised in the Studio: `prerequisites` writes only among published, approved concepts.
