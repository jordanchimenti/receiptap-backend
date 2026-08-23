-- Tap-to-pair: a merchant taps their own puck to link it to a register,
-- instead of matching its ID to a dropdown entry by hand. When no unassigned
-- sale is waiting, the puck holds this timestamp and the next sale from an
-- uncovered register binds it.
ALTER TABLE "Puck" ADD COLUMN "awaitingSaleAssignment" TIMESTAMP(3);
