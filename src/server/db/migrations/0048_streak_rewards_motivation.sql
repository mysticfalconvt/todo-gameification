-- Long-term streak rewards + personalized motivation.
--
--   progression.streak_freezes — banked streak freezes, auto-consumed to
--     survive a missed day. Earned by crossing streak milestones. This is a
--     projection column: applyEvent derives it from the event log, so the
--     default 0 is corrected on the next completion / replay.
--
--   user_prefs.motivation_style — what the user wants their list to give
--     them (balanced / xp_hunter / clean_sweep / streak_keeper). Reshapes
--     coaching emphasis and which Today stat is foregrounded; does NOT change
--     reward math.

ALTER TABLE "progression"
  ADD COLUMN IF NOT EXISTS "streak_freezes" integer NOT NULL DEFAULT 0;

ALTER TABLE "user_prefs"
  ADD COLUMN IF NOT EXISTS "motivation_style" text NOT NULL DEFAULT 'balanced'
    CHECK ("motivation_style" IN ('balanced','xp_hunter','clean_sweep','streak_keeper'));
