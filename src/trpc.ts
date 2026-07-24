import { initTRPC, TRPCError } from "@trpc/server";
import type * as trpcExpress from "@trpc/server/adapters/express";
import jwt from "jsonwebtoken";

export interface AuthUser {
  id: string;
  role: "client" | "boutique" | "livreur" | "ramasseur" | "admin";
  telephone: string;
}

export function createContext({ req }: trpcExpress.CreateExpressContextOptions) {
  let user: AuthUser | null = null;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      user = jwt.verify(token, process.env.JWT_SECRET as string) as AuthUser;
    } catch {
      user = null;
    }
  }

  return { user };
}

type Context = ReturnType<typeof createContext>;

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

// Nécessite un utilisateur connecté (tout rôle)
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Connexion requise" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

// Fabrique de middleware pour restreindre par rôle
export function requireRole(...roles: AuthUser["role"][]) {
  return t.procedure.use(({ ctx, next }) => {
    if (!ctx.user) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Connexion requise" });
    }
    if (!roles.includes(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Accès refusé pour ce rôle" });
    }
    return next({ ctx: { ...ctx, user: ctx.user } });
  });
}
