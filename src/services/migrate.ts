import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Exécute manuellement le fichier SQL de migration le plus récent contre la base Neon.
 * Utilisé quand on ne peut pas lancer `drizzle-kit migrate` localement (ex: Mac sous
 * Catalina sans binaires Node/esbuild fonctionnels) - même contrainte que MediConnect.
 *
 * Appelée via la route POST /api/admin/migrate, protégée par le header x-admin-key.
 */
export async function executerMigrations(): Promise<{ fichiersAppliques: string[] }> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL manquant");
  }

  const sql = neon(process.env.DATABASE_URL);
  const dossierMigrations = path.join(__dirname, "../../drizzle");

  const fichiers = fs
    .readdirSync(dossierMigrations)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const fichiersAppliques: string[] = [];

  for (const fichier of fichiers) {
    const contenu = fs.readFileSync(path.join(dossierMigrations, fichier), "utf-8");

    // Les fichiers générés par drizzle-kit séparent les statements par "--> statement-breakpoint"
    const statements = contenu
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const statement of statements) {
      await sql(statement);
    }

    fichiersAppliques.push(fichier);
  }

  return { fichiersAppliques };
}

/**
 * Crée le premier compte administrateur (idempotent : si le numéro existe déjà,
 * retourne son id sans créer de doublon). Appelée via POST /api/admin/seed-admin,
 * protégée par le même header x-admin-key.
 */
export async function creerCompteAdmin(params: {
  nom: string;
  telephone: string;
  motDePasse: string;
}): Promise<{ id: string; dejaExistant: boolean }> {
  const bcrypt = (await import("bcryptjs")).default;

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL manquant");
  }

  const sql = neon(process.env.DATABASE_URL);

  const existant = await sql(
    "SELECT id FROM utilisateurs WHERE telephone = $1",
    [params.telephone]
  );

  if (existant.length > 0) {
    return { id: existant[0].id as string, dejaExistant: true };
  }

  const motDePasseHash = await bcrypt.hash(params.motDePasse, 10);

  const inseré = await sql(
    `INSERT INTO utilisateurs (nom, telephone, mot_de_passe_hash, role, ville)
     VALUES ($1, $2, $3, 'admin', 'Abidjan')
     RETURNING id`,
    [params.nom, params.telephone, motDePasseHash]
  );

  return { id: inseré[0].id as string, dejaExistant: false };
}
