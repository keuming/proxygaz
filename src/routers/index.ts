import { router } from "../trpc";
import { authRouter } from "./auth";
import { gazRouter } from "./gaz";
import { ramassageRouter } from "./ramassage";
import { paiementsRouter } from "./paiements";

export const appRouter = router({
  auth: authRouter,
  gaz: gazRouter,
  ramassage: ramassageRouter,
  paiements: paiementsRouter,
});

export type AppRouter = typeof appRouter;
