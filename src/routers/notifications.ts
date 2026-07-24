import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { router, protectedProcedure } from "../trpc.js";
import { db, schema } from "../db/index.js";

const { notifications } = schema;

export const notificationsRouter = router({
  mesNotifications: protectedProcedure.query(async ({ ctx }) => {
    return db
      .select()
      .from(notifications)
      .where(eq(notifications.utilisateurId, ctx.user.id))
      .orderBy(desc(notifications.createdAt));
  }),

  marquerLu: protectedProcedure
    .input(z.object({ notificationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [notif] = await db
        .update(notifications)
        .set({ lu: true })
        .where(
          and(
            eq(notifications.id, input.notificationId),
            eq(notifications.utilisateurId, ctx.user.id)
          )
        )
        .returning();
      return notif ?? null;
    }),
});
