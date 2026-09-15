// Mirrors the Prisma `actor_type` enum as a plain literal union so this
// pure domain module has no dependency on @prisma/client (module layout:
// domain/ is pure functions, no I/O — spec §0.2).
export type ActorType = "staff" | "system" | "customer";
