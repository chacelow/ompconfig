# Interview

**Targets: known unknowns.** Brainstorming and exploration are done, but named gaps remain — decisions the user knows are open. An interview closes them in order of impact, and regularly surfaces a few unknown unknowns along the way (questions the user realizes they can't answer).

## When to run it

- After a brainstorm or blindspot pass, when the shape of the work is clear but decisions are pending.
- Before writing an implementation plan for anything with expensive-to-reverse choices.
- The user asks: "interview me", "ask me about anything ambiguous", "what do you need from me?"

## How to run it

1. **Prepare from context.** Before asking anything, re-read the task, the codebase, and any artifacts so far. Every question you could have answered yourself is a withdrawal from the user's patience budget. Interview only about what lives in their head: intent, taste, priorities, unwritten constraints.

2. **One question at a time.** Batch-dumping ten questions gets shallow answers to all of them. One at a time lets each answer reshape the next question — which is where interviews earn their keep.

3. **Order by blast radius.** Lead with questions whose answers would change the architecture, the data model, or the scope. Cosmetic questions come last or never — you can make those calls yourself and mark them as assumptions.

4. **Offer options with a recommendation.** "Should sessions be JWT or server-side? Given your existing Redis setup I'd lean server-side because X" is dramatically easier to answer than an open question — and the user's *reasoning* when they push back is itself high-value context.

5. **Watch for "I don't know".** When the user can't answer, you've found an unknown unknown wearing a known unknown's clothes. Offer to resolve it for them: a quick spike, a blindspot explainer, a prototype to react to.

6. **Know when to stop.** Stop when answers stop changing what you'd build. Then close the loop: play back the decisions as a short decision log — *decision, choice, why* — and confirm it. This document becomes an artifact for the implementation plan and for future sessions.

## Example requests this serves

- "Interview me one question at a time about anything ambiguous; prioritize questions where my answer would change the architecture."

## Pitfalls

- **Interrogating instead of interviewing.** The tone is thought partner, not intake form. Share what you'd recommend and why; let the user redirect you.
- **Asking what you can grep.** "What framework is this?" is your job. "Which of these two tradeoffs do you care about more?" is theirs.
- **Continuing past usefulness.** An interview that runs long past the architecture-changing questions trains the user to stop answering carefully.
- **Not recording the answers.** Undocumented decisions get re-litigated — or worse, silently violated — in the next session.
