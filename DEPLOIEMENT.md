# ProxiGaz Backend — Connexion Neon + Déploiement Vercel

## 1. Créer la base Neon PostgreSQL

1. Va sur https://console.neon.tech (connecte-toi avec le compte que tu utilises pour tes autres projets — MediConnect, NEXUS, etc.)
2. **New Project** → nomme-le `proxigaz`
3. Une fois créé, copie la **Connection string** (format `postgresql://user:pass@ep-xxxx.neon.tech/proxigaz?sslmode=require`)

## 2. Configurer l'environnement local (pour lancer les migrations)

Comme ton iMac tourne sous Catalina et ne peut pas exécuter Node/esbuild localement, la façon la plus simple de lancer les migrations est de le faire **depuis Vercel directement** (voir étape 4, option B), ou depuis un environnement CI type GitHub Actions.

Si tu as malgré tout un terminal Node fonctionnel ailleurs (ex: Cloud Shell, un autre poste) :

```bash
cd backend
cp .env.example .env
# Colle ta DATABASE_URL Neon dans .env
npm install
npm run db:migrate
```

## 3. Pousser le code sur GitHub

Sur ton Mac, dans le dossier `proxigaz/backend` téléchargé :

```bash
git init
git add .
git commit -m "Initial commit - backend ProxiGaz"
git branch -M main
git remote add origin https://github.com/keuming/proxigaz-backend.git
git push -u origin main
```

(Crée d'abord le repo vide `proxigaz-backend` sur https://github.com/new sous ton compte `keuming`.)

## 4. Déployer sur Vercel

### Option A — via l'interface Vercel (recommandé, cohérent avec tes autres projets)

1. https://vercel.com/new → importe le repo `keuming/proxigaz-backend`
2. Dans **Environment Variables**, ajoute :

| Variable | Valeur |
|---|---|
| `DATABASE_URL` | ta chaîne de connexion Neon |
| `JWT_SECRET` | une chaîne aléatoire longue (ex: générée via `openssl rand -hex 32`) |
| `HUB2_BASE_URL` | `https://api.hub2.io/v1` |
| `HUB2_CLIENT_ID` | ton identifiant HUB2 (même compte que MOBILE-PAY) |
| `HUB2_CLIENT_SECRET` | ton secret HUB2 |
| `API_BASE_URL` | l'URL Vercel une fois connue, ex: `https://proxigaz-backend.vercel.app` |

3. **Deploy**

### Option B — lancer la migration depuis Vercel (si pas d'accès Node ailleurs)

Après le premier déploiement réussi, Vercel expose ton app. Tu peux temporairement ajouter une route d'administration protégée (comme tu l'as fait pour MediConnect avec `/api/admin/migrate` et le header `x-admin-key`) pour exécuter `drizzle-kit migrate` à la demande — dis-moi si tu veux que je code cette route, je peux l'ajouter au routeur.

## 5. Vérifier

Une fois déployé :

```
curl https://proxigaz-backend.vercel.app/api/health
```

Doit répondre `{"status":"ok","service":"proxigaz-backend"}`.

## 6. Webhook HUB2

Dans ton tableau de bord HUB2, configure l'URL de callback :

```
https://proxigaz-backend.vercel.app/api/webhooks/hub2
```

---

**Note sur les migrations futures** : à chaque modification du schéma (`src/db/schema.ts`), relance `npm run db:generate` pour créer une nouvelle migration SQL, puis applique-la à Neon via `npm run db:migrate` (ou la route admin si tu préfères ce pattern, comme pour MediConnect).
