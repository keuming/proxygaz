import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schemaImport from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL manquant dans les variables d'environnement");
}

const sql = neon(process.env.DATABASE_URL);

export const db = drizzle(sql, { schema: schemaImport });
export const schema = schemaImport;
