// No scheduled jobs in Slice 0. Reserved for later slices' scheduled work
// (e.g. daily Buy Now price recalculation, per docs/ARCHITECTURE-MVP1.md §6.4
// and §7 "Cron" — a platform scheduler hitting an authenticated internal
// route guarded by CRON_SECRET, not an in-process timer).
export {};
