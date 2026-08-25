# Blindspot Pass

**Targets: unknown unknowns.** The user is starting work in territory they don't know — a new part of the codebase, an unfamiliar domain, a kind of work they've never done. They don't know what questions to ask, what good looks like, what historical work exists, or which potholes everyone else already knows to avoid.

## When to run it

- The user is writing a feature in a part of the codebase they've never touched.
- The user is doing unfamiliar *kinds* of work — design iteration, video editing, data modeling, infrastructure — where they can't yet judge quality.
- The user literally asks: "do a blindspot pass", "help me find my unknown unknowns", "help me prompt you better", "teach me enough to direct this work".
- You notice the request is confidently specific about a domain the user has just told you they don't know — the specificity is probably borrowed, not chosen.

## How to run it

1. **Get their starting point.** Ask (briefly) what they already know, what they've tried, and what they're ultimately trying to achieve. A blindspot pass calibrated to the wrong experience level teaches the obvious or skips the essential.

2. **Survey the territory yourself.** Read the relevant code, docs, git history, and (if appropriate) the web. You are looking for the things an experienced person would know that the user doesn't: prior art, conventions, constraints, failure modes, vocabulary.

3. **Report the blindspots, ranked by impact on their task.** Don't produce a general tutorial — produce the *delta* between what they know and what they'd need to know to direct this work well.

4. **End with leverage.** Close with the questions they should now be asking, and concretely: how they should prompt you differently now that these blindspots are visible.

## Report structure

Use this shape (as an HTML artifact if the environment renders one, otherwise markdown):

- **The terrain** — a short orientation: what this domain/module actually is, in their terms.
- **What an expert knows that you currently don't** — the ranked blindspot list. For each: what it is, why it matters *for this task*, and what happens if it's ignored.
- **Vocabulary you'll need** — the handful of terms that unlock docs, code, and better prompts.
- **Prior art & potholes** — historical decisions in this codebase or field that constrain the work; known failure modes.
- **What good looks like** — how quality is judged in this domain, so the user can start recognizing it. If they can't yet, say so and suggest a brainstorm/prototype round (see `brainstorm-prototype.md`) to develop taste by reacting.
- **How to prompt me now** — 3–5 concrete questions or instructions the user should give next, in their own voice, ready to copy.

## Example requests this serves

- "I'm adding a new auth provider but I know nothing about the auth modules in this codebase. Do a blindspot pass to help me figure out my relevant unknown unknowns and help me prompt you better."
- "I don't know what color grading is but I need to grade this video. Teach me my unknown unknowns about color grading so I can prompt better."

## Pitfalls

- **Teaching the domain instead of the delta.** The user doesn't need a course; they need the specific unknowns standing between them and directing this task.
- **Skipping the self-survey.** A blindspot pass generated from general knowledge alone misses the codebase-specific potholes — often the most expensive ones.
- **Treating it as one-shot.** Blindspots resurface at each new phase; it's fine to run a small pass again when the work enters new territory.
