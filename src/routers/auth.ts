import { z } from "zod";
import { TRPCError } from "@trpc/server";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { router, publicProcedure } from "../trpc.js";
import { db, schema } from "../db/index.js";

const { utilisateurs, ramasseurs, boutiquesGaz, livreurs } = schema;

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

  inscriptionLivreur: publicProcedure
    .input(
      z.object({
        nom: z.string().min(2),
        telephone: z.string().min(8),
        motDePasse: z.string().min(6),
        ville: z.string().min(2),
        vehicule: z.string().optional(),
        zonesCouvertes: z.array(z.string()).min(1),
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
          role: "livreur",
        })
        .returning();

      await db.insert(livreurs).values({
        utilisateurId: user.id,
        vehicule: input.vehicule,
        zonesCouvertes: input.zonesCouvertes,
        statutValidation: "en_attente", // validé manuellement par l'admin
      });

      return {
        token: genererToken(user),
        user: { id: user.id, nom: user.nom, role: user.role },
        message: "Inscription reçue, en attente de validation par l'équipe ProxiGaz",
      };
    }),

  inscriptionBoutique: publicProcedure
    .input(
      z.object({
        nom: z.string().min(2),
        telephone: z.string().min(8),
        codePin: z.string().regex(/^\d{4}$/, "Le code PIN doit comporter exactement 4 chiffres"),
        nomBoutique: z.string().min(2),
        pays: z.string().min(2).default("Côte d'Ivoire"),
        ville: z.string().min(2),
        commune: z.string().optional(),
        quartier: z.string().optional(),
        adresse: z.string().optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
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

      // Le code PIN est haché exactement comme un mot de passe classique (bcrypt) ; sa plus
      // faible entropie (4 chiffres) est compensée côté connexion par un verrouillage temporaire
      // après plusieurs tentatives échouées (voir la mutation `connexion`).
      const motDePasseHash = await bcrypt.hash(input.codePin, 10);

      const [user] = await db
        .insert(utilisateurs)
        .values({
          nom: input.nom,
          telephone: input.telephone,
          motDePasseHash,
          ville: input.ville,
          commune: input.commune,
          role: "boutique",
        })
        .returning();

      await db.insert(boutiquesGaz).values({
        utilisateurId: user.id,
        nomBoutique: input.nomBoutique,
        pays: input.pays,
        ville: input.ville,
        commune: input.commune,
        quartier: input.quartier,
        adresse: input.adresse,
        latitude: input.latitude,
        longitude: input.longitude,
        statutValidation: "en_attente", // auto-inscription : validation admin requise
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

      // Compte temporairement verrouillé suite à trop de tentatives échouées
      if (user.verrouilleJusqua && user.verrouilleJusqua > new Date()) {
        const minutesRestantes = Math.ceil((user.verrouilleJusqua.getTime() - Date.now()) / 60000);
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Trop de tentatives incorrectes. Réessayez dans ${minutesRestantes} min.`,
        });
      }

      const motDePasseValide = await bcrypt.compare(input.motDePasse, user.motDePasseHash);

      if (!motDePasseValide) {
        const nouvellesTentatives = user.tentativesEchouees + 1;
        const SEUIL_VERROUILLAGE = 5;

        await db
          .update(utilisateurs)
          .set(
            nouvellesTentatives >= SEUIL_VERROUILLAGE
              ? {
                  tentativesEchouees: 0,
                  verrouilleJusqua: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
                }
              : { tentativesEchouees: nouvellesTentatives }
          )
          .where(eq(utilisateurs.id, user.id));

        throw new TRPCError({ code: "UNAUTHORIZED", message: "Identifiants incorrects" });
      }

      if (!user.actif) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Compte désactivé" });
      }

      // Connexion réussie : on réinitialise le compteur d'échecs
      if (user.tentativesEchouees > 0 || user.verrouilleJusqua) {
        await db
          .update(utilisateurs)
          .set({ tentativesEchouees: 0, verrouilleJusqua: null })
          .where(eq(utilisateurs.id, user.id));
      }

      return { token: genererToken(user), user: { id: user.id, nom: user.nom, role: user.role } };
    }),
});
