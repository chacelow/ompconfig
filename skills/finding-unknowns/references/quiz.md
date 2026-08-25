# Quiz

**Targets: the user's unknowns about the finished work.** After a long session, more happened than the user realizes. Reading the diff gives only shallow understanding, because most of the *behavior* depends on existing code paths the diff doesn't show. The quiz makes understanding measurable: the user merges only after passing.

This is the post-hoc mirror of the blindspot pass: at the start you found the unknowns standing between the user and directing the work; now you find the unknowns standing between the user and *owning* it.

## When to run it

- After a long working session or a large change, before merge/ship.
- The user asks: "quiz me", "make sure I understand this change", "explain what happened and check that I got it".
- Proactively offer it when a session produced a change whose behavior depends heavily on pre-existing code the user may not know.

## How to run it

1. **Build the context report first.** The quiz is fair only if the user has been given what they need to pass. Produce a report (HTML artifact if available, otherwise markdown) covering:
   - **What was done** — the changes, organized by intent rather than by file.
   - **Context** — the pre-existing code paths the change interacts with; what invoked what before, what invokes what now.
   - **Intuition** — why it works, the mental model that makes the design feel inevitable rather than arbitrary.
   - **Decisions & deviations** — pulled from the implementation notes, if kept.

2. **Put the quiz at the bottom.** 5–10 questions. Target *behavior and consequences*, not trivia:
   - "A request arrives with an expired token *and* a valid refresh cookie — what happens now, and what happened before this change?"
   - "Which existing callers of `X` are affected, and which aren't? Why?"
   - "What's the first thing you'd check if <plausible symptom> shows up in production?"
   - Include at least one question about a decision or deviation ("why did we end up with server-side sessions here?") — decisions are what get re-litigated later if the owner can't reproduce the reasoning.

3. **Grade honestly, teach the gaps.** When the user answers, mark each one, and for misses explain the correct answer *and which part of the report covers it*. A miss is a located unknown — exactly what the technique exists to find.

4. **Pass before merge.** The standard the user sets ("I only merge after I pass perfectly") is theirs to choose — but hold them to the one they chose. A failed quiz means re-read, re-ask, retake; it does not mean lower the bar.

## Question quality bar

Good questions discriminate between "read the diff" and "understands the change":

- **Bad:** "Which file was the retry logic added to?" (trivia; grep answers it)
- **Good:** "If the API returns 429 three times in a row, what does the user see, and how long do they wait?" (requires the mental model)

## Example requests this serves

- "I want to make sure I understand everything that's happened in this change. Give me an HTML report on the changes — context, intuition, what was done — with a quiz at the bottom that I must pass."

## Pitfalls

- **Quizzing without teaching.** The report comes first; a quiz against context the user was never given just measures frustration.
- **Diff-level questions.** If every answer is visible in the diff, the quiz can't detect the dangerous unknowns — which live in the interaction between the change and the existing system.
- **Soft grading.** Marking a vague answer correct defeats the only purpose the quiz has. Kind tone, hard criteria.
