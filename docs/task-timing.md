# Task timing — current options

Intended as an internal reference. Use it when talking to users about what's
useful, what's redundant, and what should be trimmed once we have real
usage data.

## What changed recently

- **Past-time now fires today.** For a one-off task, if you pick a time
  that's already passed today, the task becomes due **today at that
  time** (overdue immediately). Previously it rolled silently to tomorrow.
  Recurring tasks still roll forward so their schedule stays coherent.
- **Sub-day cadences.** `interval` and `after_completion` recurrences
  accept minutes / hours / days. "Every 2 hours," "30 minutes after
  done." No schema migration — the reader tolerates both the old
  `{days: N}` shape and the new `{amount, unit}` shape.
- **"In a bit" option.** Relative offset timed task: pick N minutes or
  hours from now. Good for "fold laundry in 2h."
- **"On a specific date" option.** Calendar date (+ optional time) for
  one-off future tasks. Pairs with recurrence for "starting Wednesday,
  then weekly."

## Full option matrix

### Field 1 — When does it start?

Five mutually-exclusive picks on `/tasks/new`:

| Option              | What it does                                                                                      | Good for                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Someday**         | No due date. Lives in the Someday pile until you get to it.                                       | Ideas, backlog, wishlist items.                           |
| **Today — anytime** | Due today, no specific hour. Full XP whenever you finish it.                                      | "Do laundry at some point today."                         |
| **At a specific time** | Due today at HH:MM. 100% XP within 1h of due, 80% same day, 50% after. Past-time fires overdue. | "Take meds at 09:00."                                     |
| **In a bit**        | Relative offset: N minutes or hours from now.                                                     | "Remind me to move the car in 2h."                        |
| **On a specific date** | Future calendar date with optional HH:MM. Defaults to 09:00 local when no time set.             | "Wednesday doctor appt." / "Aug 14 oil change."          |

### Field 2 — How often?

Independent of "when." Disabled when Someday is picked.

| Option                         | Shape                                                 | Good for                                  |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------------- |
| **One-off**                    | No recurrence. Task completes and is done.            | Single errands, appointments.             |
| **Every day**                  | Daily at the task's time (if set).                    | Brush teeth, take pill.                   |
| **On specific days of the week** | Pick any subset of Sun–Sat. Renders as "Mon, Wed, Fri." | Gym three days a week.                    |
| **Every N minutes / hours / days** | Interval recurrence; fires on a schedule regardless of when last completed. | Hydration reminder every 2 hours. Bathroom clean every 10 days. |
| **N after last done**          | Fires N minutes / hours / days **after** the last completion. Slides forward when you're late. | Water plants 3 days after last watering. |

### Cross-product notes

- **Someday + any recurrence** — not allowed. Someday forces One-off.
- **Specific date + recurrence** — allowed. The picked date is the first
  occurrence; future instances follow the recurrence.
- **In a bit + recurrence** — allowed but niche. First instance is the
  offset; later ones follow the recurrence (which doesn't know about
  the offset, so the pattern starts from the offset moment).
- **Sub-day recurrences + timeOfDay pin** — intentionally decoupled. A
  "every 2 hours" task doesn't snap to a clock hour; it slides from
  wherever the last instance landed.

## Candidates for trimming

Watch these as real usage rolls in — any with <5% of created tasks after
a few weeks is a good candidate to remove or hide behind an "advanced"
toggle.

- **"In a bit"** overlaps heavily with **"At a specific time"** when the
  user does clock math themselves ("it's 4pm, I want 6pm → pick 18:00").
  Value hinges on whether clock-math friction is real.
- **"Every N minutes"** is aggressive. Few habits benefit from
  sub-hourly nudges; easy to annoy yourself.
- **"N after last done"** and **"Every N days"** often feel
  interchangeable to users even though the semantics differ (slide vs
  fixed). If users keep picking one and meaning the other, collapse.
- **"On specific days of the week"** vs **"Every day"** — if most
  weekly pickers end up selecting all 7 days, the weekly option is
  redundant.

## Signals to watch

- **Creation mix by option** — which option was picked for each task,
  sliced by new-user vs returning-user.
- **Edit frequency post-create** — did the user change the timing within
  the first day? Signals confusion at create.
- **Completion rate by option** — are "In a bit" tasks completed at a
  higher rate than "At a specific time"? That'd argue "In a bit" pays
  its keep.
- **Someday → non-Someday conversion** — how often does a Someday task
  get picked up at all? If rarely, the Someday pile is a graveyard, not
  a tool.

## Talking points for user interviews

1. "What did you want this task to happen?" — listen for the natural
   phrasing (every day, tomorrow morning, in an hour, when I'm home).
   Does one of our five options map cleanly to that phrasing?
2. "Did you notice the 'In a bit' option? When would you use it?"
3. "How would you set up a reminder for an appointment next Wednesday?"
   — watch whether they reach for Specific date or do clock-math.
4. "If I told you I was going to remove one of these options, which
   would you miss least?"
