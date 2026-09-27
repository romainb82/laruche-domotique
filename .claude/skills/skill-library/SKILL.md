---
name: skill-library
description: Routeur de la bibliothèque ECC pour ce dépôt. Indique quelles compétences ECC sont pertinentes ici (DAILY) et lesquelles restent disponibles à la demande (LIBRARY). Charger quand on hésite sur la compétence ECC à utiliser pour une tâche sur ce projet.
---

# Bibliothèque ECC — projet domotique

ECC installe 292 compétences, 68 agents et 23 jeux de règles. **Cinq jeux de règles
et une quinzaine de compétences concernent réellement ce dépôt.** Le reste n'est pas
supprimé : il reste atteignable à la demande.

Ce fichier dit lequel appeler, et quand.

## La pile, établie par relevé

| | Mesure |
|---|---|
| TypeScript | 24 fichiers `.ts`, `tsconfig.base.json`, monorepo npm workspaces |
| Vue 3 | 17 fichiers `.vue`, Pinia, Vue Router, Vite, Tailwind |
| Swift | 18 fichiers `.swift`, `Package.swift`, XcodeGen, SwiftUI, Swift 6 |
| Serveur | Fastify, WebSocket, MQTT, better-sqlite3 |
| Tests | 7 scripts maison dans `scripts/`, Playwright, XCTest |

**Absents du dépôt :** Python, Rust, Go, Java, Kotlin, Dart, PHP, C#, SQL, Docker,
CI. Aucune compétence liée à ces piles ne doit se charger ici.

## DAILY — pertinent à chaque session

### Revue
- `ecc:vue-reviewer` — API de composition, réactivité, sécurité des gabarits
- `ecc:typescript-reviewer` — sûreté de typage, asynchronisme, sécurité Node
- `ecc:swift-reviewer` — sémantique de valeur, ARC, concurrence Swift 6
- `ecc:security-reviewer` — le serveur expose une API et parle à des équipements

### Méthodes de code
- `ecc:vue-patterns`, `ecc:vite-patterns`
- `ecc:swiftui-patterns`, `ecc:swift-concurrency-6-2`
- `ecc:accessibility` — **jamais audité sur ce projet**, c'est le manque le plus net

### Règles à activer
`typescript`, `vue`, `swift`, `web`, `common`. **Rien d'autre.**

## LIBRARY — à appeler explicitement, jamais chargé d'office

| Quand | Compétence |
|---|---|
| Revoir la couche liaison / adaptateurs | `ecc:api-design`, `ecc:mcp-server-patterns` |
| Toucher au schéma SQLite | `ecc:database-migrations` |
| Préparer une mise en production | `ecc:production-audit`, `ecc:deployment-patterns` |
| Publier le projet | `ecc:opensource-pipeline` |
| Travailler l'interface | `ecc:frontend-design-direction`, `ecc:motion-patterns` |
| Empaqueter l'app iOS | `ecc:ios-icon-gen` |
| Rédiger de la documentation | `ecc:update-codemaps`, `ecc:update-docs` |

**Hors sujet ici** — ne pas charger : tout ce qui touche Python, Django, FastAPI,
Rust, Go, Java, Spring, Quarkus, Kotlin, Android, Flutter, PHP, Laravel, C++, C#,
F#, Perl, Ruby, Rails, ainsi que les compétences réseau/homelab, santé/EMR,
finance, logistique, trading et marketing.

## Ce que ce dépôt fait déjà mieux tout seul

Ne pas remplacer par un équivalent ECC :

- **Les tests.** `npm run verifier` enchaîne 5 suites, 55 assertions, plus 8 tests
  de contrat Swift. Elles interrogent le vrai serveur et décodent ses vraies
  réponses. `ecc:e2e-runner` et `ecc:tdd-guide` n'apportent rien par-dessus.
- **La vérification de types.** `npm run typecheck` couvre les trois paquets.
- **Le nettoyage des ports.** `npm run libere-ports`.

## Hooks désactivés pour ce dépôt

Dans `.claude/settings.json` :

- `stop:check-console-log` — le serveur journalise **volontairement** sur la sortie
  standard (`[canal]`, `[réseau]`, `[config]`). Sept lignes seraient signalées à
  chaque tour, à tort.
- `pre:observe:continuous-learning` — bruit sans valeur sur un dépôt personnel.

`stop:format-typecheck` reste actif : le dépôt a `npm run typecheck`, donc le hook
a de quoi travailler. Il n'a en revanche **aucun formateur** à appeler — ni
Prettier, ni ESLint, ni EditorConfig. Si tu veux qu'il serve vraiment à quelque
chose, c'est ce qu'il faut ajouter d'abord.
