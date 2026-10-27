#!/usr/bin/env bash
#
# Installe La Ruche comme agent launchd sur le Mac.
#
#   ./deploiement/installer-launchd.sh            installe et démarre
#   ./deploiement/installer-launchd.sh --retirer  arrête et désinstalle
#
# C'est une étape d'attente avant le Raspberry Pi. Voir INSTALLER-MAC.md pour
# ce que ça apporte, et ce que ça n'apporte pas.

set -euo pipefail

ETIQUETTE="fr.webpremiere.ruche"
RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CIBLE="$HOME/Library/LaunchAgents/$ETIQUETTE.plist"
DOMAINE="gui/$(id -u)"

# --------------------------------------------------------------- désinstaller

if [[ "${1:-}" == "--retirer" ]]; then
  launchctl bootout "$DOMAINE/$ETIQUETTE" 2>/dev/null || true
  rm -f "$CIBLE"
  echo "Agent retiré. Le serveur ne redémarrera plus tout seul."
  exit 0
fi

# ------------------------------------------------------------- les vérifications

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "Node est introuvable dans le PATH. Installe-le d'abord." >&2
  exit 1
fi

if [[ ! -f "$RACINE/packages/server/dist/index.js" ]]; then
  echo "Le serveur n'est pas compilé." >&2
  echo "  npm run build" >&2
  exit 1
fi

if [[ ! -f "$RACINE/packages/app/dist/index.html" ]]; then
  echo "Attention : l'interface web n'est pas compilée, le serveur ne la servira pas."
  echo "            npm run build  pour la produire."
  echo
fi

# nvm place Node dans un dossier qui porte le numéro de version. launchd ne lit
# aucun profil de shell : il faut le chemin absolu, et il devient faux à la
# prochaine montée de version.
if [[ "$NODE" == *"/.nvm/"* ]]; then
  echo "Note : Node vient de nvm ($NODE)."
  echo "       Après « nvm install » d'une nouvelle version, relance ce script,"
  echo "       sinon l'agent pointera vers un binaire qui n'existe plus."
  echo
fi

# Un agent qui tient le port 3001 en permanence empêche « npm run dev » de
# démarrer. Mieux vaut le dire maintenant que de le découvrir demain.
if lsof -nP -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Le port 3001 est déjà occupé, probablement par « npm run dev »."
  echo "Libère-le avant d'installer l'agent :  npm run libere-ports"
  exit 1
fi

# ------------------------------------------------------------- l'installation

mkdir -p "$HOME/Library/LaunchAgents" "$RACINE/data"

sed -e "s|__NODE__|$NODE|g" -e "s|__RACINE__|$RACINE|g" \
  "$RACINE/deploiement/ruche.plist" > "$CIBLE"

plutil -lint "$CIBLE" >/dev/null

# `bootout` d'abord : relancer le script doit remplacer l'agent, pas échouer
# parce qu'il est déjà chargé.
launchctl bootout "$DOMAINE/$ETIQUETTE" 2>/dev/null || true
launchctl bootstrap "$DOMAINE" "$CIBLE"
launchctl enable "$DOMAINE/$ETIQUETTE"

echo "Agent installé : $CIBLE"
echo

# Laisser au serveur le temps d'ouvrir son port avant de prétendre qu'il marche.
for _ in $(seq 1 40); do
  curl -sf -o /dev/null "http://127.0.0.1:3001/api/state" && break
  sleep 0.25
done

if curl -sf -o /dev/null "http://127.0.0.1:3001/api/state"; then
  ADRESSE="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '127.0.0.1')"
  echo "Le serveur répond.   http://$ADRESSE:3001"
  echo "Journal          :   tail -f $RACINE/data/ruche.log"
  echo "Arrêter          :   ./deploiement/installer-launchd.sh --retirer"
else
  echo "Le serveur ne répond pas encore. Regarde le journal :" >&2
  echo "  tail -30 $RACINE/data/ruche.log" >&2
  exit 1
fi
