import { router } from "../trpc.js";
import { authRouter } from "./auth.js";
import { gazRouter } from "./gaz.js";
import { ramassageRouter } from "./ramassage.js";
import { paiementsRouter } from "./paiements.js";
import { adminRouter } from "./admin.js";
import { notificationsRouter } from "./notifications.js";

export const appRouter = router({
  auth: authRouter,
  gaz: gazRouter,
  ramassage: ramassageRouter,
  paiements: paiementsRouter,
  admin: adminRouter,
  notifications: notificationsRouter,
});

export type AppRouter = typeof appRouter;
