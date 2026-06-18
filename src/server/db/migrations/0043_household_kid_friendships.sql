-- Backfill auto-friendships for existing household kids.
--
-- Kids can't use the friend-request flow, but they should appear on
-- their family's social surfaces (leaderboard, activity, friends list).
-- Going forward this is wired up in syncHouseholdKidFriendships(); this
-- migration retroactively connects kids already in households.
--
-- For every pair of members in the same household where at least one
-- side is a kid (kiosk excluded), insert a single accepted friendship
-- row — but only when no friendship row already exists in either
-- direction, so existing real friendships and blocks are never touched.
--
-- The `(om.role <> 'kid' OR km.user_id < om.user_id)` guard collapses
-- kid<->kid pairs to one canonical direction so we don't insert both
-- A->B and B->A. (kid<->adult pairs are emitted once as kid->adult.)
INSERT INTO friendships (requester_id, addressee_id, status, responded_at)
SELECT km.user_id, om.user_id, 'accepted', now()
FROM household_members km
JOIN household_members om
  ON om.household_id = km.household_id
 AND om.user_id <> km.user_id
WHERE km.role = 'kid'
  AND om.role <> 'kiosk'
  AND (om.role <> 'kid' OR km.user_id < om.user_id)
  AND NOT EXISTS (
    SELECT 1 FROM friendships f
    WHERE (f.requester_id = km.user_id AND f.addressee_id = om.user_id)
       OR (f.requester_id = om.user_id AND f.addressee_id = km.user_id)
  )
ON CONFLICT DO NOTHING;
