# Design: P6 client signer and agent tools

> **STATUS 2026-09-02: FIFTH REVISION — design rounds closed.** Third blocked gate. Three of the
> four blockers are fixed below. The fourth is the one the gate and I have now disagreed about in
> three consecutive rounds, and under the finite-rounds rule that makes it a human decision rather
> than a fourth assertion. Both readings are stated in "The hosted question, unresolved after three
> rounds" — I am not restating mine as settled.
>
> Fixed: `resume` and the crash path swept out of the remaining criteria that still called them
> reads; the journal's intent row `fsync`ed before the RPC call rather than merely written, and the
> **signature nonce** separated from the **transaction nonce**, which the previous revision called by
> one name; the V1 deadline reassigned from S3, which was complete and about something else, to S4,
> which migrates the routes.
>
> **STATUS 2026-09-01: FOURTH REVISION after the second gate.** Six blockers. One of them is the
> third occurrence today of a single failure — **I fold in corrections and leave the older text that
> contradicts them standing** — so this revision sweeps the whole document rather than patching
> sites, and the sweep is listed at the end of this header.
>
> **The query rule was invented for a field that does not exist.** The parent's signature table
> (`2026-08-27-p6-reputation-and-agents.md:243-249`) carries `method` and `path` and **no query**.
> A canonicalization rule for query strings is therefore unverifiable by design: nothing on the other
> side reads it. Corrected below into the rule that actually follows — the query is not signed, so a
> signed route may not take meaningful input through it.
>
> **The journal closed a wider window than the one that exists.** A crash after the RPC accepted the
> transaction but before the hash reached disk still loses it, because acceptance and persistence are
> two steps and the gap between them is not zero.
>
> **The journal covered acceptance only.** Registration, event reporting and content-key requests are
> mutations with the same retry problem and were left out.
>
> **The V1 deadline was assigned to no stage.** Calling it "a parent-side dependency" named a
> repository, not an owner, and a dependency with no stage is a dependency nobody delivers.
>
> Sweep performed: acceptance criteria scoped to "the new tools" removed, since all ten sign; the
> hosted allow-list is now enumerated by name rather than described.
>
> **STATUS 2026-09-01: THIRD REVISION after the gate.** Five blockers, all confirmed by reading the
> code rather than the note. Two were my errors of reading rather than of design, and both have the
> same shape: I read the part addressed to me and not the whole.
>
> **`resume` is not a read.** `contribution-acceptance-application-service.ts:214` calls
> `prepareContributionAcceptanceMetadata` whenever the attempt is `PREPARING` — pinning to IPFS and
> writing to the database. All ten acceptance tools sign; the read/write split I drew is wrong.
>
> **The gate said the hosted decision was already taken. Checked: it refers to a different server.**
> The parent's line 17 governs `volem-mcp`, which `README.md:11` states lives in the Volem app and
> exposes only DB-backed reads. **This** package is the client/self-custody MCP and owns the full
> read/write toolset by design. So the parent does not settle it, and it remains a decision —
> though a much better informed one, see below.
>
> The other three blockers are real gaps: no durable journal for a hash produced before a crash, an
> idempotency key that does not survive a restart, and a V1 deadline with no publication mechanism.
>
> **STATUS 2026-09-01: SECOND REVISION.** The pre-gate review found this design's central premise
> false, and finding it uncovered a live defect. I verified that a hosted/stdio boundary *exists*
> and wrote the design on top of it; I did not check **what it gates**. It gates one tool. Roughly
> eight others sign with the host wallet and write to Volem on hosted HTTP today — including
> `get_content`, which is one of the three V1 sign sites this delivery migrates. Establishing the
> boundary is now part of this delivery rather than an assumption it rests on, and that turns a
> question about new tools into a decision about existing ones. Details in "The boundary does not
> exist yet" below.
>
> **STATUS 2026-09-01: ACTIVE.** Release-dependent sibling of Volem P6 (S7 of
> `/Users/user/project/dev/volem/docs/plans/2026-09-01-p6-reputation-and-agent-surface-implementation.md`).
> Every premise below was verified against live code on 2026-09-01 before it was written, because the
> parent phase spent two of its four gate rounds arguing about premises that had already stopped
> being true.

**Parent:** Volem P6. **Blocks:** S8, the cross-repository acceptance.

## What this delivery is

Volem is replacing a signature that binds nothing. This repository is one of the two things that
sends that signature, so the scheme cannot change on one side alone: the day Volem retires V1 on a
route, every client still signing V1 stops working on that route.

That is the whole reason this is a linked workflow with a release dependency rather than a follow-up.

## Verified starting state

Each of these was read, not assumed:

| Claim | Verified |
|---|---|
| Three call sites sign the V1 scheme | `volem-events.ts:34`, `volem-registration.ts:23`, `tools/content.ts:35` — all `signMessage({ message: \`volem:${timestamp}\` })` |
| Those are the same three routes Volem enumerated | registration, event reporting, content-key — matches the parent's retirement list |
| `src/index.ts` is exactly 700 lines | `wc -l` = 700. The file-size guard means it may only shrink |
| ~~A hosted/stdio boundary already exists~~ | **FALSE, and the correction is the largest thing in this design.** `buildServer({ allowInstallSkill })` gates exactly one tool — the sole `if (allowInstallSkill)` is `index.ts:372`, wrapping `install_skill` alone. Every other `server.tool(` is unconditional, and the hosted session at `index.ts:602` passes `false` for that one flag only |
| Tests run on `node --test` over `tests/*.test.ts`, with a `tests/fixtures/` directory | `package.json:38` |

## The boundary does not exist yet, and building it is a decision about existing tools

The doc comment at `index.ts:42-48` states the rule exactly right:

> On a hosted HTTP server the filesystem and wallet are the SERVER's, so a remote caller triggering
> an install writes to the host and spends the host's funds.

**That reasoning is applied to one tool.** These sign with the host wallet and reach Volem, and all
of them are registered unconditionally, so a remote HTTP caller reaches them today:

| Tool | Writes through |
|---|---|
| `register_work`, `register_derivative` | `postToVolem` — `register-work.ts:494` |
| `mint_license` | `postVolemEvent` — `license.ts:100` |
| `set_licensing_config` | `postVolemEvent` — `license-config.ts:107` |
| `pay_royalty`, `claim_revenue` | `postVolemEvent` — `royalty.ts` |
| `get_content` | `volemAuthHeader` — `content.ts:83`, signing at `content.ts:35` |

A repo-wide search for a second gate — `readOnly`, `isHosted`, an allow-list — found none.

**This is the third live defect this phase's design work has found**, after the register-route
ownership check and the content-key column read, and it has the same shape as both: a rule written
correctly in a comment and applied in one place.

## The hosted question, unresolved after three rounds

Three gate rounds, three disagreements, no movement. Under the finite-rounds rule this stops being
something to argue and becomes something to decide. Both readings, stated fairly:

**The gate's reading:** the parent plan fixes hosted read-only, so the eight signing tools exposed on
this package's HTTP transport are a defect against a settled constraint, and closing them needs no
decision.

**My reading:** the parent's constraint names `volem-mcp`, which `README.md:11` places inside the
Volem app exposing DB-backed reads only. This package is described in the same file as the
client/self-custody MCP owning the full read/write toolset, and it is deployed over HTTP deliberately
per `docs/deploy-runbook.md`. So the parent does not reach it, and closing the eight removes
capability from a live deployment.

**What both readings agree on**, and what matters more than which is right:

- `docs/deploy-runbook.md:80-81` makes `CP_NEAR_PRIVATE_KEY` and `CP_EVM_PRIVATE_KEY` **required**
  for the hosted deployment.
- Eight tools sign with them unconditionally: registration, derivative registration, licence minting,
  licensing config, royalty payment, revenue claim, and gated-content retrieval.
- A holder of the deployment's bearer token can therefore spend the host's funds.
- Nobody disputes that this should not be so. The dispute is only whether closing it is a decision
  or an obligation — and the fix is identical either way.

**Recommendation: close it.** If the human agrees, the disagreement was never load-bearing. If the
human wants the hosted writers kept, that is the answer no reading of the parent could have given,
which is exactly why it needed a person.

---

**The superseded argument, kept for the record.** The parent's read-only constraint
names `volem-mcp`, a separate server inside the Volem app (`README.md:11`); this package is
deliberately the full read/write client. Nothing in the parent governs this repository's HTTP mode.

**But the facts that decide it are now on the table, and they are worse than the last revision knew.**
`docs/deploy-runbook.md:80-81` lists `CP_NEAR_PRIVATE_KEY` and `CP_EVM_PRIVATE_KEY` as **required**
for the hosted Railway deployment. The server therefore holds both keys, and the eight unconditional
tools sign with them. A caller holding the deployment's bearer token can make the host register
works, mint licences, pay royalties, claim revenue and fetch gated content, spending the host's NEAR
and Story funds.

The blast radius is bounded by that bearer token rather than open to the internet, which is why this
is a decision on a deployed system and not an incident. **My recommendation is unchanged and now
stronger: gate the whole signing surface.** The runbook's own P4 section gated `install_skill` for
precisely this reason — "может авто-минтить лицензию с host-кошелька… опасно" — and stopped at one
tool.

**And the gate must cover the whole surface, not only Volem writes.** The rule is about what a
remote caller can make the *host* do, so it covers signing keys, filesystem writes, and chain
writes to NEAR and Story as well as posts to Volem. Enumerating only the Volem writers, as the
table above does, understates it: a tool that spends host funds on Story is exposed by the same
gap even though Volem never hears about it.

## The signature is one implementation with shared vectors

**The canonicalizer is written once and proven equal by fixtures, not by reading.** Volem's carried
risk B27 says the same thing from its side: a field the verifier reads and the signer does not write
is the failure mode, and prose has not caught it in four rounds.

- The EVM2 canonicalizer lands here as its own module with no MCP or network imports, so it is
  testable as a pure function and diffable against Volem's copy.
- **Golden vectors are the contract.** A fixture file of signed payloads with their exact bytes and
  expected signatures lives in `tests/fixtures/`, and the identical file is committed in Volem. S8
  runs both against the same vectors with real keys. A divergence fails the release, not a review.
- Vectors cover at minimum: each of the three migrated routes, an empty body, a body with non-ASCII
  content, and a nonce at the boundary of its range.

⚠️ **The query is not signed, and that is a constraint on routes rather than a gap in the scheme.**
The parent's field table is `domain, chainId, address, method, path, bodySha256, issuedAt,
expiresAt, nonce, action, idempotencyKey` — no query. So:

- **No signed route may take meaningful input through the query string.** Everything that matters
  goes in the body, which is hashed. A signed route reading a query parameter is a defect, because
  that parameter is outside the signature and anyone in the path can change it.
- One vector proves it rather than asserting it: **the same request with a different query produces
  the same signature.** That test failing means someone added a query field on one side only.
- If a route genuinely needs a query parameter under signature, the field table changes and that is
  a parent-side change, not a local one.

**V1 stays only as an explicit fallback, bounded by the server's announced deadline.** Not a silent
retry-on-failure: falling back automatically when EVM2 is rejected is how a broken EVM2
implementation ships unnoticed and how the replay window stays open. The fallback is configuration
the operator sets, and it logs every use.

⚠️ **The deadline needs somewhere to come from, and today there is nowhere.** The previous revision
said it "comes from the server" and named no mechanism; the server publishes no such value. Without
one, "bounded by the deadline" is a sentence the code cannot execute, and the fallback is bounded by
nothing.

**This is a dependency with an owner and a stage, not just a repository.** Naming "the Volem side"
named a place and no one; a dependency assigned to no stage is one nobody delivers.

**Owner: Volem, stage S4** — "dual-stack legacy route migration", the stage that actually migrates
the routes. The previous revision said S3, which is "one acceptance application boundary and agent-author
eligibility" and was already complete; I named a stage without reading the stage list, which is the
same failure as naming a repository without an owner. It publishes per-route
V1 retirement dates on an **unauthenticated** endpoint, so a client can refuse V1 past the date
without a human relaying it. **S7 consumes it; S8 verifies both sides against the same dates.**
If S3 ships without it, this delivery falls back to the operator-configured path below and says so
in its own note rather than discovering it at S8. Until that exists here, the fallback is bounded by
explicit operator configuration with **no default** — the operator states a date or gets no
fallback — and the client logs that it is running on a locally-asserted deadline rather than a
published one. That is weaker and it is honest; a silent unbounded fallback is neither.

## What is added, and where it may run

**Read tools stay available everywhere.** Public thread list and detail need no wallet and no
signature, and they run on hosted HTTP as they do on stdio. That is the entire set: **all ten
acceptance tools sign**, including `resume`, and none of them is hosted-available.

**Every tool that signs is local-only**, behind the gate this delivery builds:

- thread create and reply
- **all ten** contribution-acceptance tools

The rule is the one already written in `index.ts:44`: on hosted HTTP the wallet is the *server's*,
so a remote caller triggering a signature spends someone else's money.

⚠️ **The previous revision said `resume` and `load` only read, and gated them on a weaker
argument.** That was wrong about `resume`:
`contribution-acceptance-application-service.ts:214` pins metadata and writes when the attempt is
`PREPARING`. It signs like the rest and is gated for the same reason as the rest. `load` does read,
and is gated because an in-flight attempt carries the host's reserved nonce and prepared calldata —
host-local operational state. The weaker reason is stated separately for the one tool it applies to,
because a gate justified by an argument that does not fit its contents is one someone later removes
for a right-sounding reason.

## A local journal, because a tool cannot record a hash it never wrote down

The previous revision said `record` is how a hash gets home after a crash. That is wrong in the
case it names: **a process that dies between broadcast and record never persisted the hash at all**,
so there is nothing for `record` to send. The separate tool answers the case where the *caller*
lost the response, not where this process died holding the only copy.

**A durable local journal, written before the wallet is asked to broadcast.** One append-only file
under the client's own state directory, one record per attempt:

| Written | When |
|---|---|
| attempt id, action, **idempotency key**, canonical request bytes, **signature nonce** | before the request is signed |
| **intent-to-broadcast**, with the sender address and the **transaction nonce** | immediately before the RPC call, and `fsync`ed before the call returns control |
| transaction hash | as soon as the RPC returns one, before anything else |
| terminal outcome | when the server confirms |

⚠️ **Two different nonces, and the earlier revision used one word for both.** The **signature nonce**
is 128 bits of CSPRNG in the EVM2 payload and exists to stop replay; the **transaction nonce** is the
wallet's sequence number on chain. They are journalled in different rows for different reasons, and
reconciliation by identity uses the transaction nonce alone. Conflating them is how a recovery path
searches the chain for a number that was never on it.

⚠️ **The intent row must be durable before the RPC call, not merely written.** A buffered write that
has not reached disk is lost by exactly the crash it exists for, so the intent row is `fsync`ed and
the RPC call does not begin until it is. This costs one sync per broadcast and buys the only thing
the row is for.

⚠️ **The intent row exists because acceptance and persistence are two steps.** A crash after the RPC
accepted the transaction and before the hash reached disk leaves no hash — the previous revision's
journal did not close that, it only made it smaller. The intent row does not recover the hash; it
records that **a transaction may exist at this sender and nonce**, which is enough to find it: the
recovery path reconciles by identity, exactly as Volem's own reconciler does, rather than by a hash
nobody has.

Two things follow, and they are blockers three and four:

- **The hash survives the crash**, because it is written the moment it exists rather than after the
  round trip that may not happen.
- **The idempotency key survives the restart.** A key generated per process is a new key after a
  crash, and a fresh key on the same intent is precisely how one intent becomes two effects. The key
  is generated once, journalled with the request, and reused on every retry of that attempt.

On start, the client reads the journal:

- a record with a hash and no terminal outcome is offered for `record`;
- **a record with an intent and no hash is offered for reconciliation by sender and nonce**, which is
  the case the hash cannot answer.

That is what makes crash recovery a path rather than an aspiration.

**The journal covers every mutation, not only acceptance.** Registration, event reporting and the
content-key request are retried by the same callers under the same crashes, and an idempotency key
that survives a restart is worth exactly as much to them. One journal, one record shape, every
signed mutation — a second mechanism for the other three is how they drift.

⚠️ The journal holds a nonce and request bytes, not a key. It is host-local state and one more
reason none of these tools may run on hosted HTTP.

## Acceptance is orchestrated, and the crash path stays separate

`prepare` may compose **prepare → local wallet broadcast → record** for the ordinary path, because
three round trips for one intent is a bad tool.

But `record` remains its own tool, and this is not redundancy:

- **A caller that lost the response still holds the hash.** `record` is how that hash gets home.
  It is *not* the answer to a dead process, which holds nothing — that is the journal's job, and the
  earlier text claiming otherwise is corrected in the journal section above.
- **`resume` never starts a second attempt, though it does write.** It pins metadata when the
  attempt is `PREPARING` (`contribution-acceptance-application-service.ts:214`), which is
  idempotent on the attempt and reuses the journalled idempotency key. What it must never do is
  prepare a *second* operation: an orchestration that silently re-prepares is how one intent becomes
  two transaction nonces, and Volem's P5 spent two review rounds on that class.
- **`load` reads and writes nothing.**

## Extraction, because the file may only shrink

`src/index.ts` is at 700 lines and the guard is a hard limit. Volem tool registration moves out to
its own module, and the new tools register there rather than in `index.ts`. This is the change
profile's over-700-lines row, and it is a precondition of the delivery rather than tidying.

## Scope

- The EVM2 canonicalizer, action registry, nonce and idempotency-key generation, audience and chain
  configuration, and a signed fetch helper.
- Migration of the three V1 call sites to EVM2, with V1 as explicit bounded fallback.
- Golden fixtures shared byte-for-byte with Volem.
- Public thread list and detail; signed thread create and reply.
- The ten acceptance tools, with `prepare` composing the ordinary path.
- Extraction of Volem tool registration out of `src/index.ts`.
- **Commit discipline:** unrelated dirty files are preserved and only owned paths are committed.
  Stated because S7 requires it explicitly and nothing else in this design implies it.

## Out of scope

- Any hosted write path.
- Reputation, gradient, ordering — none of it reaches this repository.
- Changing what Volem's routes accept. This side signs; the other side decides.
- The operator and grant surface. It is Volem-side and stays there.

## Acceptance criteria

- **This repository's signer reproduces every expected value in the fixture file**, and the fixture
  file is byte-identical to the copy committed in Volem, verified by diff. The real-key cross-repository
  run belongs to S8 and is not restated here as an S7 bar — S7 precedes S8, so a criterion S8 owns
  cannot gate S7.
- **Each of the three migrated call sites actually sends an EVM2 request.** Fixture equivalence
  proves the canonicalizer is right; it does not prove anything calls it. Checked at the request
  level, not at the module level.
- **A V1 fallback invocation is logged, and is refused once the announced deadline has passed.**
- `stdio` enumeration includes every tool. **Hosted HTTP enumeration matches an explicit allow-list
  and nothing else**, and the allow-list is enumerated by name rather than described:

  `search_works`, `get_asset`, `get_agent`, `get_revenue`, `get_revenue_all`,
  `verify_provenance`, plus the two new public thread tools `list_threads` and `get_thread`.

  Everything not on that list is absent from hosted enumeration — including the eight that sign
  today. The test asserts the **exact set**, not a subset, because a subset test passes while a new
  signing tool leaks in.

  ⚠️ **This list is the design's recommendation and the open decision above owns it.** If the human
  keeps the eight exposed, this criterion changes with that answer and the list grows by those eight
  — it does not quietly stand as written. Stated here rather than left implicit, because an
  acceptance criterion that pre-empts an open decision is how the decision gets made by nobody.
- A dropped response after broadcast is recovered by `record` alone, with no second prepare.
- `resume` and `load` on an in-flight attempt return state and start nothing.
- `src/index.ts` is shorter than 700 lines.
- `yarn test`, `yarn typecheck`, `yarn build` pass.

## Follow-up outside this delivery

**`docs/deploy-runbook.md` section P4 is stale and should say so.** It presents gating
`install_skill` as the hosted-safety measure, with a rationale that applies equally to eight tools it
does not mention. Leaving it as written is how the next person concludes the surface is handled.
Correcting it is a documentation change, not part of this delivery's code, and it should not wait
for this delivery either way.

## Risks

**The two repositories can drift between commits.** Vectors prove equality at S8, not continuously.
Until both sides are released together, a change to either canonicalizer is a silent break, and the
only thing catching it is that S8 runs last.

**V1 fallback is a window that stays open while it is configured on.** Bounded by the server's
deadline, logged on every use, and removed rather than defaulted off — but it is the one path where
a replayable signature still reaches a Volem route.

**Eight existing tools sign on hosted HTTP and this delivery may or may not close that**, depending
on the decision above. While it is open, the hosted server keeps a write path that the boundary this
delivery builds exists to forbid, and the two coexist in one file.

**A local-only rule is enforced by where a tool is registered, not by what it does.** Attaching a
signing tool outside the gate would expose it on hosted HTTP, and nothing in the type system stops
that. The enumeration test is the guard, which makes it load-bearing rather than a nicety.
