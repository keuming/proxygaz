import { router } from "../trpc.js";
import { authRouter } from "./auth.js";
import { gazRouter } from "./gaz.js";
import { ramassageRouter } from "./ramassage.js";
import { paiementsRouter } from "./paiements.js";

export const appRouter = router({
  auth: authRouter,
  gaz: gazRouter,
  ramassage: ramassageRouter,
  paiements: paiementsRouter,
});

export type AppRouter = typeof appRouter;
