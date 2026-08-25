---
name: finding-unknowns
description: A collaboration framework for closing the gap between what the user asked for (the map) and what the work actually requires (the territory). Use whenever a task is ambiguous, long-horizon, high-stakes, in a domain or codebase area the user says they don't know well, or "I'll know it when I see it"-shaped — even if the user never says the word "unknowns". Routes to eight techniques across three phases: blindspot pass, brainstorm & prototype, interview, reference code, implementation plan (before building); implementation notes (while building); pitch & explainer, quiz (after building). Also use when the user mentions blindspots, unknown unknowns, ambiguity, scoping, requirements discovery, "help me prompt better", or asks to be interviewed or quizzed about a change.
---

# Finding Unknowns

The prompt you receive is a **map**: a compressed representation of work that lives somewhere else — in the codebase, the design, the real world. That somewhere else is the **territory**, and it has constraints the map doesn't show. The difference between map and territory is made of **unknowns**, and every unknown you hit mid-task forces you to guess what the user wants. The more work you do in one stretch, the more guesses accumulate.

On capable models doing long-horizon work, unresolved unknowns — not capability — are usually the quality bottleneck. When a long task comes back wrong, the cause is rarely "the model couldn't do it"; it's that nobody found the unknowns until they were expensive.

This skill is a toolkit for finding unknowns deliberately — before, during, and after implementation — instead of discovering them as rework.

## The four kinds of knowledge

Sort what the user knows about the task into four boxes:

|  | The user knows it | The user doesn't know it |
|---|---|---|
| **…and they're aware of that** | **Known knowns** — what's in the prompt. | **Known unknowns** — gaps they can name: undecided requirements, open questions. |
| **…and they're not aware of that** | **Unknown knowns** — tacit knowledge so obvious they'd never write it down, but they'd recognize a violation instantly ("that's not what I meant"). | **Unknown unknowns** — things they haven't considered at all. They may not know what questions to ask, what good looks like, or how good the result *could* be. |

The best collaborators aren't the ones with no unknowns — they're the ones who *assume* unknowns exist and budget cheap probes to find them. That's what each technique below is: a cheap probe, compared to the cost of reworking an implementation built on a wrong guess.

## Why calibration fails both ways

Instruction-following is a dial, and unaccounted-for unknowns break it at both ends:

- **Too specific**: you follow the letter of the instructions even when the territory says a pivot would serve the user better.
- **Too vague**: you fill gaps with industry best practices that may not fit this codebase, this team, this taste.

You can't fix this by picking one end. You fix it by shrinking the gap — resolving the unknowns that matter and making the remaining ones explicit, so the user knows where you'll be improvising.

## When to reach for this skill

Activate when you notice any of these signals — the user rarely says "I have unknowns":

- The user says some version of *"I don't know"*, *"not sure"*, *"I have no taste for this"*, *"new to this part of the codebase"*, *"never done X before"*.
- The request uses quality adjectives with no criteria attached: *clean*, *modern*, *nice*, *polished*, *fast*.
- The task is long-horizon, where mid-course guesses compound silently.
- The request names a solution, but the surrounding context hints the *problem* might be better solved another way.
- The stakes are asymmetric: a wrong guess is expensive to undo (data model choices, public APIs, anything user-facing).
- After the fact: a large diff or long session the user hasn't internalized.

Most tasks need **zero or one** technique. A simple, well-specified task deserves a direct answer, not a framework — running the full ceremony on "rename this function" is worse than not having the skill at all. Match the technique to the phase and the dominant unknown type, and skip the rest.

## Routing table

| You observe | Dominant unknown | Technique | Read |
|---|---|---|---|
| User is new to the domain or this area of the codebase; doesn't know what questions to ask or what good looks like | Unknown unknowns | **Blindspot pass** | `references/blindspot-pass.md` |
| Taste/visual/UX criteria the user can only judge by reacting; scope not yet settled | Unknown knowns | **Brainstorm & prototype** | `references/brainstorm-prototype.md` |
| The user can name their open questions but hasn't answered them | Known unknowns | **Interview** | `references/interview.md` |
| The user can point at an example of what they want but can't describe it | Hard-to-verbalize wants | **Reference code** | `references/reference-code.md` |
| Ready to build, and mid-flight guesses would be expensive | Residual unknowns before commitment | **Implementation plan** | `references/implementation-plan.md` |
| Building now; the plan is meeting reality | Unknowns discovered in flight | **Implementation notes** | `references/implementation-notes.md` |
| Work is done; other people need to understand and approve it | The reviewers' unknowns | **Pitch & explainer** | `references/pitch-explainer.md` |
| Work is done; the user hasn't internalized what changed | The user's unknowns about the change | **Quiz** | `references/quiz.md` |

When the user uses a technique's literal name — "do a blindspot pass", "interview me", "quiz me on this change" — skip the diagnosis and go straight to that reference.

## Operating principles

These apply across every technique:

1. **Anchor on the user's starting point.** Ask where they are in their thought process; learn their experience with the problem and the codebase. The same task has completely different unknowns for a domain expert and a first-timer, and the techniques only work when calibrated to the person. Work with them as a thought partner, not a ticket queue.

2. **Search before you ask.** You can read the codebase and the internet far faster than the user can answer questions, and you likely know more about the average topic than they do. Resolve every unknown you can reach yourself; spend the user's attention only on unknowns that live in their head — intent, taste, priorities, constraints they haven't written down.

3. **Make unknowns reactable.** People are far better at reacting than specifying. A named assumption, a rendered variant, a mock with fake data, a plan that leads with its most contestable decisions — each converts a silent guess into something the user can confirm or veto in seconds. When the environment can render HTML, an HTML artifact is usually the best way to visualize and present these; otherwise use clear markdown.

4. **Source code is the richest reference.** When the user points at a library, module, or website they like, read the underlying implementation, not the screenshot or the docs. Markup, structure, and semantics carry detail no description can.

5. **Surface, decide, log — don't stall.** When you find an unknown mid-implementation and the user isn't available, pick the conservative option, log the deviation, and keep going. An unknown you've written down is recoverable; one you silently guessed through is not.

6. **Finding unknowns can change the problem.** Sometimes a blindspot pass or brainstorm reveals that the user should be solving a different problem entirely, or that the result could be far better than they imagined. Say so — that's the highest-value outcome this skill produces, not a failure of scoping.

## The full arc (when a task deserves it)

For a large or unfamiliar piece of work, the techniques compose into a loop:

1. **Blindspot pass** — map the terrain, learn what questions to ask.
2. **Brainstorm & prototype** — set scope with intent; surface unknown knowns by reacting to variants.
3. **Interview** — close the remaining known unknowns, highest-impact first.
4. **Reference code** — pin down anything the user can point at but not describe.
5. **Implementation plan** — lead with the decisions most likely to change; get sign-off.
6. *(Often: start a fresh session, passing the plan, spec, and prototypes as artifacts.)*
7. **Implementation notes** — log decisions and deviations as reality pushes back.
8. **Pitch & explainer** — package the work so reviewers cross the same gap quickly.
9. **Quiz** — verify the user actually understands what shipped before they merge.

Each artifact from an earlier step is context for the later ones — carry them forward rather than re-deriving them. Planning ahead is not always enough: unknowns surface deep in implementation, and sometimes they tell you to solve the problem differently. That's the loop working, not the loop failing.
