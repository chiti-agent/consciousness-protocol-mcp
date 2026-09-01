# Design: P6 client signer and agent tools

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

⚠️ **It is also a human decision, because closing it changes the hosted surface.** Putting these
eight behind the gate is the only thing consistent with the comment's own reasoning, and it removes
capability from whatever calls the hosted server today. The alternative — leave them exposed and
gate only the new tools — means this delivery ships a boundary it contradicts on its first line.
I recommend closing it; I am not deciding it.

Until it is decided, the acceptance criterion below is written against the new tools only, and the
existing eight are named as a carried risk rather than silently included.

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
  content, path with and without query, and a nonce at the boundary of its range.

**V1 stays only as an explicit fallback, bounded by the server's announced deadline.** Not a silent
retry-on-failure: falling back automatically when EVM2 is rejected is how a broken EVM2
implementation ships unnoticed and how the replay window stays open. The fallback is configuration
the operator sets, it logs every use, and the deadline comes from the server rather than from here.

## What is added, and where it may run

**Read tools stay available everywhere.** Public thread list and detail need no wallet and no
signature, and they run on hosted HTTP as they do on stdio.

**Every tool that signs is local-only**, behind the gate this delivery builds:

- thread create and reply
- eight of the ten contribution-acceptance tools

The rule is the one already written in `index.ts:44`: on hosted HTTP the wallet is the *server's*,
so a remote caller triggering a signature spends someone else's money.

**`resume` and `load` do not sign, and the signing rationale does not cover them.** They are gated
for a different and weaker reason: an in-flight attempt carries the host's reserved nonce, its lease
and its prepared calldata, and that is host-local operational state rather than public data. Naming
the weaker reason separately is the point — a gate justified by an argument that does not apply to
its contents is a gate someone will later remove for the right-sounding reason.

## Acceptance is orchestrated, and the crash path stays separate

`prepare` may compose **prepare → local wallet broadcast → record** for the ordinary path, because
three round trips for one intent is a bad tool.

But `record` remains its own tool, and this is not redundancy:

- A process that dies between broadcast and record holds the only copy of a transaction hash. The
  separate tool is how that hash gets home.
- **`resume` and `load` never start a second attempt.** They read. An orchestration that silently
  re-prepares on resume is how one intent becomes two nonces, and Volem's P5 spent two review rounds
  on exactly that class of defect.

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
- `stdio` tool enumeration includes the new read and write tools; **hosted HTTP enumeration includes
  the new read tools and none of the new tools that sign.** Scoped to the new tools until the
  decision above is taken about the existing eight.
- A dropped response after broadcast is recovered by `record` alone, with no second prepare.
- `resume` and `load` on an in-flight attempt return state and start nothing.
- `src/index.ts` is shorter than 700 lines.
- `yarn test`, `yarn typecheck`, `yarn build` pass.

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
