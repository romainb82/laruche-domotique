# Domotique

Pilotage éclairage / volets / chauffage / piscine pour une maison de plain-pied,
développé **avant** que le matériel soit installé.

Voir le cadrage complet : https://claude.ai/code/artifact/d1b9edd8-3667-4b59-9fcc-0d4353bc2356

---

## Démarrer

```bash
npm install
npm run dev
```

- Interface : http://localhost:5173
- API : http://localhost:3001

Au premier lancement, la base est vide : le serveur y sème la maison lue sur le
plan — 15 zones, 72 équipements. Tout est ensuite modifiable depuis l'écran
**Paramétrage**, jamais dans le code.

---

## Le principe

Tout le système est écrit contre une seule interface, `DeviceDriver`, avec deux
implémentations interchangeables :

| | `SimDriver` | `MqttDriver` |
|---|---|---|
| Quand | aujourd'hui | après la mise en service |
| Ce qu'il fait | maison virtuelle, physique crédible | parle au vrai matériel |
| Volet | met 22 s à descendre | met le temps qu'il met |
| Température | dérive selon l'inertie configurée | vient des sondes |
| pH | monte lentement, comme un vrai bassin | vient du régulateur |

Le jour de la bascule, il n'y a **aucun code à écrire** : on remplit le
raccordement MQTT de chaque équipement dans l'écran Paramétrage, on bascule le
driver, et c'est tout. Un équipement non raccordé reste simplement simulé — on
peut donc équiper la maison **pièce par pièce**, en vivant avec le mélange.

Le simulateur ne disparaît pas ensuite : il reste l'environnement de test —
valider un scénario de chauffage sans attendre janvier, déclencher une alarme de
pH sans toucher au bassin.

---

## Les deux règles tenues dans le code

**L'état vient toujours du matériel, jamais du clic.** Aucune mise à jour
optimiste : on envoie la commande, et on attend que le driver pousse l'état
réel. Entre les deux, l'équipement est `pending` et l'interface affiche
« en cours » — un troisième état visuel, ni allumé ni éteint. Un délai de garde
bascule en échec si la confirmation n'arrive jamais, plutôt que de laisser
tourner indéfiniment. → `packages/server/src/state.ts`

**Une valeur périmée ne pilote rien.** Un capteur sur pile qui meurt ne renvoie
pas d'erreur : il se tait. Chaque équipement porte un délai de fraîcheur
au-delà duquel il passe en `stale`, et l'interface affiche « — » plutôt qu'une
mesure de la semaine dernière.

---

## Structure

```
packages/
  shared/    types de domaine, schéma de configuration, maison de référence
  server/    Fastify + WebSocket + drivers + SQLite
  app/       PWA Vue 3
```

Les types sont **partagés** entre serveur et interface : le contrat ne peut pas
diverger.

### Pourquoi SQLite et pas PostgreSQL

Le cadrage prévoyait PostgreSQL sur un mini-PC. Le serveur tourne finalement sur
un Raspberry Pi : un fichier unique, aucun service à superviser, sauvegarde par
simple copie, et largement de quoi tenir les ~2 M de points par an que produit
la maison. PostgreSQL serait un conteneur et 200 Mo de RAM pour rendre
exactement le même service.

Rien ne passe par le réseau : **si la fibre tombe, la maison continue de
fonctionner.**

---

## Vérifier

Les suites tournent contre le serveur réellement démarré, jamais contre des
simulacres : c'est la seule façon de voir un volet mettre du temps à arriver.

```bash
npm run verifier        # 89 tests : API, cerveau, HTTP, Modbus, HomeKit, scènes, interface
npm run audit:a11y      # accessibilité du web, mesurée par axe-core
npm run audit:a11y:ios  # accessibilité de l'app iOS, sur simulateur
```

L'audit d'accessibilité mesure trois choses qu'une relecture ne voit pas :
le contraste réellement calculé, la taille des cibles une fois la mise en page
faite, et ce que l'arbre d'accessibilité contient vraiment. Côté iOS il parcourt
trois écrans en défilant — l'accueil, une pièce et le général — parce que
XCUITest ne relève que ce qui est à l'écran.

---

## Sur le Raspberry Pi

Un Pi 5 avec 4 Go suffit largement. Deux points qui comptent :

1. **Démarrer sur SSD ou clé USB, pas sur carte SD.** La carte SD est le point
   de panne classique d'un Pi qui écrit en continu — et ce serveur écrit une
   mesure par seconde.
2. **Un onduleur**, même petit. Une microcoupure ne doit pas laisser les volets
   à mi-course et la base en écriture.

```bash
npm ci && npm run build
node packages/server/dist/index.js
```

Variables d'environnement : `PORT` (3001), `HOST` (0.0.0.0), `DB_FILE`.

Pour un démarrage automatique, un service systemd suffit — pas besoin de Docker
sur une machine dédiée à ça.

---

## Les canaux disponibles

Chaque équipement choisit le sien ; tout ce qui n'est pas raccordé reste servi
par le simulateur.

| Canal | Pour quoi | Découverte |
|---|---|---|
| Simulateur | tout ce qui n'est pas encore installé | sans objet |
| MQTT | Shelly, Zigbee2MQTT, la plupart des modules | écoute les topics |
| HTTP | régulateurs, passerelles, onduleurs | liste les points d'entrée |
| Modbus TCP | pompes à chaleur, CTA, compteurs | balayage de registres |

Le Modbus mérite un mot : le protocole n'a **aucune** découverte. Un équipement
Modbus ne sait pas dire ce qu'il contient, seule la documentation du fabricant
le dit. À la place, le canal propose un balayage — il lit une plage de registres
et montre ce qui s'y trouve, en direct, avec les lectures plausibles côte à côte.
On touche à la machine, on regarde quelle case bouge. L'adresse s'écrit
`table:adresse[:type]`, par exemple `holding:100:int16`, et commence à 0 : un
document qui annonce 40101 en notation Modicon désigne `holding:100` ici.

La liaison série RTU n'est pas couverte. Elle demanderait un pilote natif qui se
compile mal sur un Pi, et la même grammaire d'adresse s'y appliquera le jour où
ce sera nécessaire.

---

## Le pont HomeKit

Éteint par défaut. Une fois ouvert depuis le paramétrage, la maison apparaît
dans l'app Maison d'Apple, donc dans Siri, les automatisations et les téléphones
des autres habitants.

Le pont ne double pas le cerveau : il le lit et lui transmet, exactement comme
l'interface web. Les deux règles tiennent, y compris depuis Siri — une lampe
allumée à la voix ne s'affiche allumée qu'une fois le module confirmé, et un
équipement injoignable devient « pas de réponse » dans l'app Maison plutôt
qu'une vieille valeur présentée comme vraie.

Trois choses à savoir :

1. **Le code d'association doit être changé.** Celui d'usine circule partout.
2. **Le pH, le redox et la puissance ne sont pas exposés.** HomeKit n'a aucun
   service pour ces grandeurs, et les déguiser en température donnerait des
   relevés absurdes. Le paramétrage liste ce qui a été écarté, et pourquoi.
3. **L'association survit aux redémarrages.** L'identifiant du pont est dérivé
   du nom de la maison, donc stable : changer de machine ou refaire la base
   n'oblige pas à réassocier.

---

## Ce qui n'est pas encore là

Le squelette couvre le socle, le pilotage et le paramétrage complet. Restent,
dans l'ordre du cadrage :

- **L2** — programmation horaire du chauffage, réduit nocturne, repli d'absence,
  et surtout l'historisation par pièce qui préparera l'arbitrage de zonage
- **L3** — moteur de règles, scénarios départ / arrivée / nuit
- **L4** — lecture du régulateur de piscine (jamais l'injection : voir R2 du cadrage)
- **L5** — suivi de consommation
- **Modbus série (RTU)** — la grammaire d'adresse est prête, le transport non

Deux questions ouvertes bloquent une partie de L2 : le chauffage est-il à air
soufflé ou à radiateurs à eau, et y a-t-il un neutre dans les boîtes
d'interrupteur.
# laruche-domotique
