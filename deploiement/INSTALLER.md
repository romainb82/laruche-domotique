# Installer La Ruche sur le Raspberry Pi

Le serveur tourne en service système : il démarre au boot, redémarre seul s'il
tombe, et ne dépend plus d'un Mac allumé.

Le principe de rangement : **le code dans `/opt/ruche`**, remplacé à chaque
déploiement, et **l'état dans `/var/lib/ruche`**, qui survit à tout. Les deux
chemins d'état sont pilotés par `DB_FILE` et `HOMEKIT_DIR`, déclarés dans
l'unité.

---

## 1. Préparer le Pi

Raspberry Pi OS 64 bits (Bookworm ou plus récent).

```bash
# Le fuseau, sinon les scénarios du planificateur se déclenchent à côté.
sudo timedatectl set-timezone Europe/Paris

# Node 22. Le dépôt Debian est trop ancien.
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git build-essential python3

# Le courtier MQTT, par lequel passent Shelly et Zigbee2MQTT.
sudo apt install -y mosquitto mosquitto-clients
sudo systemctl enable --now mosquitto

# L'utilisateur du service : pas de connexion, pas de dossier personnel.
sudo useradd --system --home /opt/ruche --shell /usr/sbin/nologin ruche
```

Vérifier où Node s'est installé :

```bash
command -v node        # attendu : /usr/bin/node
```

Si le chemin diffère, corriger `ExecStart=` dans `ruche.service`.

## 2. Déployer le code

> **À ne pas faire : copier `node_modules` depuis le Mac.** `better-sqlite3`
> est un module natif, compilé pour l'architecture de la machine. Un binaire
> macOS arm64 ne se charge pas sous Linux arm64, et l'erreur qu'on obtient
> alors ne ressemble à rien de compréhensible. On installe et on compile **sur
> le Pi**.

```bash
sudo git clone <l-adresse-du-depot> /opt/ruche
sudo chown -R ruche:ruche /opt/ruche

cd /opt/ruche
sudo -u ruche npm ci        # les dépendances de build sont nécessaires
sudo -u ruche npm run build # compile shared, serveur et interface web
```

`npm run build` produit aussi `packages/app/dist`, que le serveur sert
lui-même : pas de nginx, pas de second service.

## 3. Reprendre la configuration existante

Sans cette étape le Pi repart de la maison d'exemple, et tu perds le plan, les
pièces et les scénarios déjà saisis.

Depuis le Mac, serveur **arrêté** des deux côtés :

```bash
# Sur le Mac, dans le dépôt :
scp data/domotique.db ruche@<ip-du-pi>:/tmp/
```

```bash
# Sur le Pi :
sudo mkdir -p /var/lib/ruche
sudo mv /tmp/domotique.db /var/lib/ruche/
sudo chown -R ruche:ruche /var/lib/ruche
```

Les fichiers `-wal` et `-shm` ne se copient pas : SQLite les reconstruit. Ils
ne doivent simplement pas contenir d'écriture en attente, d'où le serveur
arrêté.

## 4. Installer le service

```bash
sudo ln -s /opt/ruche/deploiement/ruche.service /etc/systemd/system/ruche.service
sudo systemctl daemon-reload
sudo systemctl enable --now ruche
```

## 5. Vérifier

```bash
systemctl status ruche
journalctl -u ruche -f
```

Trois lignes doivent apparaître au démarrage :

```
[web]     interface servie depuis /opt/ruche/packages/app/dist/
[réseau]  annoncé en Bonjour : ruche.local:3001
[http]    http://localhost:3001  ·  base /var/lib/ruche/domotique.db
```

Puis depuis n'importe quel appareil de la maison :

```bash
curl -s http://ruche.local:3001/api/auth/etat
```

Et sur le téléphone : ouvrir **http://ruche.local:3001** dans Safari, puis
Partager → **Sur l'écran d'accueil**.

Le vrai test est celui-ci : `sudo reboot`, et l'application doit répondre
toute seule deux minutes plus tard, sans que personne ne touche à rien.

## 6. Mettre à jour

```bash
cd /opt/ruche
sudo -u ruche git pull
sudo -u ruche npm ci
sudo -u ruche npm run build
sudo systemctl restart ruche
```

L'état n'est pas touché : il est ailleurs.

## 7. Si la découverte automatique flanche

Le serveur s'annonce lui-même. Sur Raspberry Pi OS, `avahi-daemon` tourne déjà
et occupe le port mDNS ; les deux cohabitent le plus souvent, mais si l'app
iOS ne trouve pas la maison, confie l'annonce à avahi :

```bash
sudo cp /opt/ruche/deploiement/ruche-avahi.service /etc/avahi/services/ruche.service
sudo systemctl restart avahi-daemon
```

Puis fais taire celle du serveur, sinon le problème existe en double. Dans
`ruche.service`, ajouter sous les autres `Environment=` :

```ini
Environment=BONJOUR=off
```

```bash
sudo systemctl daemon-reload && sudo systemctl restart ruche
```

Si le Pi ne s'appelle pas `ruche`, corriger le champ `host` du fichier avahi :
l'application iOS construit l'adresse du serveur à partir de ce champ.

---

## Comptes et accès

Le serveur exige un compte : au premier lancement, l'interface demande de
créer l'administrateur. Trois rôles : l'administrateur règle tout, l'habitant
pilote et voit les caméras, l'invité allume la lumière et ouvre les volets.
L'unité est durcie en plus : utilisateur dédié, disque en lecture seule hors
`/var/lib/ruche`, familles de sockets restreintes.

Deux précautions :

- **Ne lance jamais `npm run verifier` sur cette machine.** Les scripts de
  vérification réécrivent la configuration et, sur une base vierge, créent
  un administrateur au mot de passe public. Ils refusent de tourner contre
  une maison configurée, mais pas contre une base encore vide.
- **Pas d'exposition hors du réseau local** sans tunnel privé (Tailscale,
  WireGuard) : jamais de redirection de port sur la box. Derrière un tunnel,
  pense à `HABITANTS=off` pour ne plus lister les prénoms avant connexion.
