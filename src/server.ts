import "dotenv/config";
import express from "express";
import cors from "cors";
import * as trpcExpress from "@trpc/server/adapters/express";
import { eq } from "drizzle-orm";
import { appRouter } from "./routers";
import { createContext } from "./trpc";
import { db, schema } from "./db";
import { executerMigrations } from "./services/migrate";

const app = express();

app.use(cors());
app.use(express.json());

app.use(
  "/api/trpc",
  trpcExpress.createExpressMiddleware({
    router: appRouter,
    createContext,
  })
);

// Route d'administration : exécute les migrations SQL en attente contre Neon.
// Protégée par une clé secrète transmise en header (même pattern que MediConnect).
app.post("/api/admin/migrate", async (req, res) => {
  const cleAdmin = req.headers["x-admin-key"];
  if (!process.env.ADMIN_MIGRATE_KEY || cleAdmin !== process.env.ADMIN_MIGRATE_KEY) {
    return res.status(401).json({ error: "Clé admin invalide ou manquante" });
  }

  try {
    const resultat = await executerMigrations();
    res.status(200).json({ success: true, ...resultat });
  } catch (err) {
    console.error("Erreur migration:", err);
    res.status(500).json({
      error: "Échec de la migration",
      details: err instanceof Error ? err.message : String(err),
    });
  }
});

// Webhook HUB2 : notification de statut de paiement (push depuis HUB2, pas de polling nécessaire)
app.post("/api/webhooks/hub2", async (req, res) => {
  try {
    const { external_reference, status, transaction_id } = req.body;

    if (!external_reference) {
      return res.status(400).json({ error: "external_reference manquant" });
    }

    const nouveauStatut =
      status === "SUCCESS" ? "reussi" : status === "FAILED" ? "echoue" : "en_attente";

    await db
      .update(schema.paiements)
      .set({
        statut: nouveauStatut,
        hub2TransactionId: transaction_id,
        rawResponse: req.body,
        updatedAt: new Date(),
      })
      .where(eq(schema.paiements.id, external_reference));

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Erreur webhook HUB2:", err);
    res.status(500).json({ error: "Erreur interne" });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "proxigaz-backend" });
});

// IMPORTANT : le handler 404 doit toujours être le dernier middleware
app.use((_req, res) => {
  res.status(404).json({ error: "Route non trouvée" });
});

const PORT = process.env.PORT || 4000;

// En local (npm run dev) on écoute sur un port classique.
// Sur Vercel, la fonction serverless (api/index.ts) importe `app` sans jamais
// appeler listen() ; c'est Vercel qui gère l'invocation HTTP.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`ProxiGaz backend démarré sur le port ${PORT}`);
  });
}

export default app;
