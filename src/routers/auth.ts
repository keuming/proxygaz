import { z } from "zod";
import { TRPCError } from "@trpc/server";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { router, publicProcedure } from "../trpc.js";
import { db, schema } from "../db/index.js";

const { utilisateurs, ramasseurs, boutiquesGaz } = schema;

function genererToken(user: { id: string; role: string; telephone: string }) {
  const payload: { id: string; role: string; telephone: string } = {
    id: user.id,
    role: user.role,
    telephone: user.telephone,
  };
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "30d" });
}

export const authRouter = router({
  inscriptionClient: publicProcedure
    .input(
      z.object({
        nom: z.string().min(2),
        telephone: z.string().min(8),
        motDePasse: z.string().min(6),
        ville: z.string().min(2),
        commune: z.string().optional(),
        adresseDefaut: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const existant = await db
        .select()
        .from(utilisateurs)
        .where(eq(utilisateurs.telephone, input.telephone));

      if (existant.length > 0) {
        throw new TRPCError({ code: "CONFLICT", message: "Ce numéro est déjà utilisé" });
      }

      const motDePasseHash = await bcrypt.hash(input.motDePasse, 10);

      const [user] = await db
        .insert(utilisateurs)
        .values({
          nom: input.nom,
          telephone: input.telephone,
          motDePasseHash,
          ville: input.ville,
          commune: input.commune,
          adresseDefaut: input.adresseDefaut,
          role: "client",
        })
        .returning();

      return { token: genererToken(user), user: { id: user.id, nom: user.nom, role: user.role } };
    }),

  inscriptionRamasseur: publicProcedure
    .input(
      z.object({
        nom: z.string().min(2),
        telephone: z.string().min(8),
        motDePasse: z.string().min(6),
        ville: z.string().min(2),
        type: z.enum(["particulier", "societe"]),
        nomSociete: z.string().optional(),
        zonesCouvertes: z.array(z.string()).min(1),
        vehicule: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const existant = await db
        .select()
        .from(utilisateurs)
        .where(eq(utilisateurs.telephone, input.telephone));

      if (existant.length > 0) {
        throw new TRPCError({ code: "CONFLICT", message: "Ce numéro est déjà utilisé" });
      }

      const motDePasseHash = await bcrypt.hash(input.motDePasse, 10);

      const [user] = await db
        .insert(utilisateurs)
        .values({
          nom: input.nom,
          telephone: input.telephone,
          motDePasseHash,
          ville: input.ville,
          role: "ramasseur",
        })
        .returning();

      await db.insert(ramasseurs).values({
        utilisateurId: user.id,
        type: input.type,
        nomSociete: input.nomSociete,
        zonesCouvertes: input.zonesCouvertes,
        vehicule: input.vehicule,
        statutValidation: "en_attente", // validé manuellement par l'admin
      });

      return {
        token: genererToken(user),
        user: { id: user.id, nom: user.nom, role: user.role },
        message: "Inscription reçue, en attente de validation par l'équipe ProxiGaz",
      };
    }),

  connexion: publicProcedure
    .input(z.object({ telephone: z.string(), motDePasse: z.string() }))
    .mutation(async ({ input }) => {
      const [user] = await db
        .select()
        .from(utilisateurs)
        .where(eq(utilisateurs.telephone, input.telephone));

      if (!user) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Identifiants incorrects" });
      }

      const motDePasseValide = await bcrypt.compare(input.motDePasse, user.motDePasseHash);
      if (!motDePasseValide) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Identifiants incorrects" });
      }

      if (!user.actif) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Compte désactivé" });
      }

      return { token: genererToken(user), user: { id: user.id, nom: user.nom, role: user.role } };
    }),
});
