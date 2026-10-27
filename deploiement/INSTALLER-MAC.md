# Faire tourner La Ruche sur le Mac, en attendant le Pi

```bash
npm run build
./deploiement/installer-launchd.sh
```

Le script vérifie ce qu'il faut, remplit le gabarit avec les chemins réels,
installe l'agent dans `~/Library/LaunchAgents/` et attend que le serveur
réponde avant de te dire que c'est bon.

Pour l'arrêter et le désinstaller :

```bash
./deploiement/installer-launchd.sh --retirer
```

Journal : `tail -f data/ruche.log`

---

## Ce que ça apporte

Le serveur démarre à l'ouverture de session, survit à la fermeture du
terminal, et redémarre tout seul s'il tombe. Tu n'as plus de commande à
relancer à la main.

## Ce que ça n'apporte pas

**Le Mac est un portable.** Il dort quand tu rabats l'écran, et il sort de la
maison. Pendant ce temps l'application n'a personne au bout du fil : ni sur ton
téléphone, ni sur celui de Mélissa. Aucun réglage launchd n'y changera quoi que
ce soit : c'est la machine qui ne convient pas au rôle.

**Ça démarre à l'ouverture de session, pas au boot.** Après un redémarrage, le
serveur n'existe pas tant que personne n'a ouvert la session. Un *daemon*
démarrerait plus tôt, mais le dépôt vit sous `~/Documents`, que macOS protège :
un processus lancé hors session s'y voit refuser l'accès, sans message
compréhensible. L'agent hérite des autorisations de la session et évite tout ce
chapitre.

C'est une étape d'attente. Le Raspberry Pi est la vraie réponse : voir
[INSTALLER.md](INSTALLER.md).

## Deux pièges

**L'agent tient le port 3001 en permanence**, donc `npm run dev` refusera de
démarrer tant qu'il tourne. Le script le détecte à l'installation, mais pas
après. Avant de reprendre le développement :

```bash
./deploiement/installer-launchd.sh --retirer
```

**Node vient de nvm**, dont le chemin porte le numéro de version. launchd ne lit
aucun profil de shell : le chemin absolu est figé dans le fichier installé.
Après un `nvm install` d'une nouvelle version, relance le script, sinon l'agent
pointe vers un binaire qui n'existe plus, et il échouera en silence toutes les
dix secondes.
