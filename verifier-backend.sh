#!/bin/bash
# Vérification complète ProxiGaz backend - toutes les routes et tables
# Usage: bash verifier-backend.sh

set -e
API="https://proxygaz-backend.vercel.app"
ADMIN_KEY="879897d2af3e0c9bf3a20be539e61530951bc149f9569fb69040d949fbc34618"
ADMIN_TEL="0700000099"
ADMIN_PASS="Insitu@30121978"

echo "=== 1. Santé du serveur ==="
curl -s "$API/api/health"; echo

echo -e "\n=== 2. Connexion admin ==="
ADMIN_RESP=$(curl -s -X POST "$API/api/trpc/auth.connexion" \
  -H "Content-Type: application/json" \
  -d "{\"telephone\":\"$ADMIN_TEL\",\"motDePasse\":\"$ADMIN_PASS\"}")
echo "$ADMIN_RESP"
ADMIN_TOKEN=$(echo "$ADMIN_RESP" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

echo -e "\n=== 3. Création d'une marque de gaz (admin.creerMarqueGaz) ==="
MARQUE_RESP=$(curl -s -X POST "$API/api/trpc/admin.creerMarqueGaz" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"nom":"Orybel","taille":"B6","prixRecharge":3500,"prixConsigne":8000}')
echo "$MARQUE_RESP"
MARQUE_ID=$(echo "$MARQUE_RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

echo -e "\n=== 4. Création d'une boutique (admin.creerBoutique) ==="
BOUTIQUE_RESP=$(curl -s -X POST "$API/api/trpc/admin.creerBoutique" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"nom":"Gérant Test","telephone":"0710000001","motDePasse":"test1234","nomBoutique":"Depot Cocody Test","ville":"Abidjan","commune":"Cocody"}')
echo "$BOUTIQUE_RESP"
BOUTIQUE_ID=$(echo "$BOUTIQUE_RESP" | grep -o '"boutique":{"id":"[^"]*"' | cut -d'"' -f6)

echo -e "\n=== 5. Ajout de stock (admin.majStock) ==="
curl -s -X POST "$API/api/trpc/admin.majStock" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d "{\"boutiqueId\":\"$BOUTIQUE_ID\",\"marqueGazId\":\"$MARQUE_ID\",\"quantiteDisponible\":50}"; echo

echo -e "\n=== 6. Inscription d'un client test ==="
CLIENT_RESP=$(curl -s -X POST "$API/api/trpc/auth.inscriptionClient" \
  -H "Content-Type: application/json" \
  -d '{"nom":"Client Verif","telephone":"0720000001","motDePasse":"test1234","ville":"Abidjan","commune":"Cocody"}')
echo "$CLIENT_RESP"
CLIENT_TOKEN=$(echo "$CLIENT_RESP" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

echo -e "\n=== 7. Catalogue gaz (doit contenir la marque créée) ==="
curl -s "$API/api/trpc/gaz.catalogue" -H "Authorization: Bearer $CLIENT_TOKEN"; echo

echo -e "\n=== 8. Création d'une commande gaz ==="
COMMANDE_RESP=$(curl -s -X POST "$API/api/trpc/gaz.creerCommande" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLIENT_TOKEN" \
  -d "{\"marqueGazId\":\"$MARQUE_ID\",\"boutiqueId\":\"$BOUTIQUE_ID\",\"quantite\":1,\"adresseLivraison\":\"Rue des Jardins, Cocody\"}")
echo "$COMMANDE_RESP"
COMMANDE_ID=$(echo "$COMMANDE_RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

echo -e "\n=== 9. Confirmation commande (admin.confirmerCommande via gaz.confirmerCommande, rôle admin) ==="
curl -s -X POST "$API/api/trpc/gaz.confirmerCommande" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d "{\"commandeId\":\"$COMMANDE_ID\"}"; echo

echo -e "\n=== 10. Démarrage livraison (gaz.demarrerLivraison) ==="
curl -s -X POST "$API/api/trpc/gaz.demarrerLivraison" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d "{\"commandeId\":\"$COMMANDE_ID\",\"livreurNom\":\"Yao\",\"livreurTelephone\":\"0750000001\"}"; echo

echo -e "\n=== 11. Marquer livrée (gaz.marquerLivree) ==="
curl -s -X POST "$API/api/trpc/gaz.marquerLivree" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d "{\"commandeId\":\"$COMMANDE_ID\"}"; echo

echo -e "\n=== 12. Notifications du client (doit contenir 'Commande confirmée') ==="
curl -s "$API/api/trpc/notifications.mesNotifications" -H "Authorization: Bearer $CLIENT_TOKEN"; echo

echo -e "\n=== 13. Inscription d'un ramasseur test ==="
RAMASSEUR_RESP=$(curl -s -X POST "$API/api/trpc/auth.inscriptionRamasseur" \
  -H "Content-Type: application/json" \
  -d '{"nom":"Ramasseur Verif","telephone":"0730000001","motDePasse":"test1234","ville":"Abidjan","type":"particulier","zonesCouvertes":["Cocody"]}')
echo "$RAMASSEUR_RESP"
RAMASSEUR_TOKEN=$(echo "$RAMASSEUR_RESP" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

echo -e "\n=== 14. Liste des ramasseurs en attente (admin) + validation ==="
RAMASSEURS_LIST=$(curl -s "$API/api/trpc/admin.listRamasseurs" -H "Authorization: Bearer $ADMIN_TOKEN")
echo "$RAMASSEURS_LIST"
RAMASSEUR_ID=$(echo "$RAMASSEURS_LIST" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

curl -s -X POST "$API/api/trpc/admin.validerRamasseur" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d "{\"ramasseurId\":\"$RAMASSEUR_ID\",\"approuver\":true}"; echo

echo -e "\n=== 15. Création demande de ramassage (par le client) ==="
DEMANDE_RESP=$(curl -s -X POST "$API/api/trpc/ramassage.creerDemande" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLIENT_TOKEN" \
  -d '{"adresse":"Rue des Jardins, Cocody","ville":"Abidjan","commune":"Cocody","typeDechet":"menager"}')
echo "$DEMANDE_RESP"
DEMANDE_ID=$(echo "$DEMANDE_RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

echo -e "\n=== 16. Validation de la demande par le ramasseur (premier qui valide) ==="
curl -s -X POST "$API/api/trpc/ramassage.validerDemande" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAMASSEUR_TOKEN" \
  -d "{\"demandeId\":\"$DEMANDE_ID\"}"; echo

echo -e "\n=== 17. Démarrage du ramassage (ramassage.demarrerRamassage) ==="
curl -s -X POST "$API/api/trpc/ramassage.demarrerRamassage" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAMASSEUR_TOKEN" \
  -d "{\"demandeId\":\"$DEMANDE_ID\"}"; echo

echo -e "\n=== 18. Fin du ramassage (ramassage.terminerDemande) ==="
curl -s -X POST "$API/api/trpc/ramassage.terminerDemande" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAMASSEUR_TOKEN" \
  -d "{\"demandeId\":\"$DEMANDE_ID\"}"; echo

echo -e "\n=== 19. Stats admin (doit refléter tous les mouvements ci-dessus) ==="
curl -s "$API/api/trpc/admin.stats" -H "Authorization: Bearer $ADMIN_TOKEN"; echo

echo -e "\n=== FIN DE LA VÉRIFICATION ==="
