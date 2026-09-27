# L'app Apple

Deux dossiers, deux rôles :

| | Quoi | Comment on l'ouvre |
|---|---|---|
| `DomoKit/` | Le **paquet Swift** : types du domaine, client REST, flux WebSocket, découverte Bonjour, état observable. Aucune interface. | `swift build`, `swift test` — ou ouvrir `Package.swift` |
| `Maison/` | L'**app iOS** SwiftUI. C'est ici qu'est le projet Xcode. | `open Maison/Maison.xcodeproj` |

`DomoKit` n'a **pas** de projet Xcode : c'est un paquet Swift, il n'en a pas besoin.
Le `project.yml` de XcodeGen vit dans `Maison/`.

---

## Démarrer

```bash
# 1. le cerveau doit tourner
npm run dev                    # depuis la racine du dépôt

# 2. l'app
cd packages/ios/Maison
open Maison.xcodeproj
```

Le projet est déjà généré. On ne le régénère que si `project.yml` change
(ajout d'un fichier source, d'une clé Info.plist, d'une dépendance) :

```bash
cd packages/ios/Maison
xcodegen generate
```

`Maison.xcodeproj` est un **produit**, pas une source : il se régénère, il ne
se modifie pas à la main. Les réglages vivent dans `project.yml`.

---

## Les tests de contrat

```bash
cd packages/ios/DomoKit
swift test
```

Ils ne vérifient pas du Swift : ils vérifient que le Swift et le TypeScript
racontent la même histoire. Chaque test interroge le **vrai** serveur et décode
sa **vraie** réponse. Une dérive du contrat casse ici, au moment de compiler,
plutôt que sur le téléphone six mois plus tard.

Ils sont ignorés si le cerveau ne tourne pas — pas de suite rouge parce qu'on a
oublié `npm run dev`.

---

## Sur le simulateur, sans Xcode

```bash
cd packages/ios/Maison
xcodebuild -project Maison.xcodeproj -scheme Maison \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath /tmp/domo-dd build

SIM=$(xcrun simctl list devices available | grep -m1 'iPhone 17 Pro' | grep -oE '[0-9A-F-]{36}')
xcrun simctl boot $SIM
xcrun simctl install $SIM /tmp/domo-dd/Build/Products/Debug-iphonesimulator/Maison.app
xcrun simctl launch $SIM fr.webpremiere.maison

# ouvrir directement sur une pièce (pratique pour les captures)
xcrun simctl launch $SIM fr.webpremiere.maison --args -zone z03
```

---

## Sur ton iPhone

Ouvrir le projet, sélectionner le téléphone, puis **Signing & Capabilities** →
mettre ton Apple ID en équipe.

Avec un compte gratuit, l'app expire au bout de 7 jours et il faut la
réinstaller. Les 99 €/an ne deviennent utiles que pour les widgets persistants
et les raccourcis Siri.

---

## Comment l'app trouve la maison

Le serveur s'annonce en Bonjour (`_domotique._tcp`) et publie son **nom d'hôte
réel** dans l'enregistrement TXT — pas le nom du service. Confondre les deux
mène à chercher un `maison.local` qui n'existe pas.

L'app cherche, **vérifie que l'adresse répond vraiment**, et ne bascule que si
c'est le cas : une annonce Bonjour peut survivre au serveur qui l'a émise. À
défaut, elle retombe sur `localhost:3001`.

Deux clés Info.plist sont indispensables, et déjà dans `project.yml` :
`NSLocalNetworkUsageDescription` et `NSBonjourServices`. Sans elles, iOS bloque
la découverte en silence.
