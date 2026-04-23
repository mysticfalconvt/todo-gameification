-- Backfill category_slug on arcade onboarding tasks created by 0017. Only
-- touches tasks whose owner still has the 'other' category — leaves custom
-- taxonomies alone, matching categories.ts's "seed only when empty" rule.

UPDATE "tasks" t
SET "category_slug" = 'other',
    "updated_at" = NOW()
FROM "user_categories" uc
WHERE t."external_ref" IN (
        'onboarding-try-wordle',
        'onboarding-try-memory-flip'
      )
  AND t."category_slug" IS NULL
  AND uc."user_id" = t."user_id"
  AND uc."slug" = 'other';
