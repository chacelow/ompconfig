# Reference Code

**Targets: hard-to-verbalize wants.** Sometimes the user can't describe what they want — they lack the vocabulary, or a full description would take longer than the work itself. But they can *point at something that already does it*. A reference collapses an unbounded specification problem into "make it like that one".

The absolute best reference is **source code**. Diagrams, docs, and screenshots are compressed and lossy; an implementation carries the exact semantics, edge cases, markup, and structure — richer detail than any description.

## When to run it

- The user names a library, module, product, or site: "like how X does it", "same behavior as Y".
- The user struggles to specify behavior precisely (retry semantics, animation feel, layout responsiveness, error-handling philosophy) but you suspect an existing implementation embodies it.
- Proactively: when an interview question is getting long-winded, ask **"is there something that already does this the way you like?"** — often the single highest-leverage question in a spec conversation.

## How to run it

1. **Get a pointer, not a description.** A folder path, a package name, a URL. If it's a website, read the underlying code (fetched markup, styles, scripts) — not just a screenshot. Structure and implementation carry the detail that matters.

2. **Read for semantics, not syntax.** The reference may be in a different language or framework than the target — that's fine and common. Extract the *behavioral contract*: the states, the transitions, the edge cases, the defaults, the failure handling. Write these down as the spec.

3. **Confirm the boundary.** References always contain more than the user wants. Play back what you extracted and ask which parts are essential and which are incidental: "I see it does exponential backoff with jitter, caps at 30s, and treats 429 differently from 503 — do you want all three?"

4. **Reimplement idiomatically.** Port the semantics, not the code style. The target codebase's conventions win on everything the reference wasn't consulted for.

5. **Cite the reference in your artifacts.** In the plan or notes, record "backoff semantics from `vendor/rate-limiter`" — future sessions (and reviewers) get the same shortcut the user gave you.

## Example requests this serves

- "This Rust crate in `vendor/rate-limiter` implements the exact backoff behavior I want. Read it and reimplement the same semantics in our TypeScript API client."
- "I love the command palette on this site — go read how it's actually built and do ours like that."

## Pitfalls

- **Screenshot thinking.** Judging a reference by its surface loses exactly the detail that made it worth referencing. Read the implementation.
- **Copying instead of porting.** Wholesale translation imports the reference's constraints and bugs alongside its behavior.
- **Assuming scope.** The user pointed at the component for its *feel*; you ported its analytics hooks too. Confirm the boundary.
- **Forgetting references exist.** The failure mode isn't running this technique badly — it's spending twenty interview questions trying to extract what one pointer would have given you.
