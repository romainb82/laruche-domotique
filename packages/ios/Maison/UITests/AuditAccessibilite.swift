import XCTest

/// L'audit d'accessibilité, mesuré sur l'app en fonctionnement.
///
/// L'équivalent iOS de `scripts/audit-a11y.mjs` : une revue de code ne voit
/// pas ce que l'arbre d'accessibilité contient réellement, ni la taille
/// effective d'une cible une fois la mise en page faite.
///
/// Trois choses sont mesurées, celles qui manquaient toutes les trois avant :
///   · chaque commande porte un nom prononçable ;
///   · chaque cible atteint les 44 × 44 pt d'Apple ;
///   · la mise en page tient encore à la plus grande taille de texte.
///
/// Deux pièges ont coûté cher et expliquent la forme du code ci-dessous.
///
/// 1. XCUITest ne voit que ce qui est à l'écran. Un premier jet ne mesurait
///    que le haut de l'accueil et laissait passer des boutons de 40 pt — d'où
///    le défilement, et les trois écrans, choisis pour montrer chaque sorte de
///    tuile.
/// 2. Interroger les éléments un par un pendant que la vue bouge échoue de
///    loin en loin : l'élément relevé n'existe plus quand on lit sa taille.
///    D'où l'instantané unique, lu ensuite comme une simple donnée.
/// Le minimum tactile d'Apple, en points.
private let cibleMin: CGFloat = 44

/// XCUITest rend des fractions : une cible nominale de 44 pt se relève parfois
/// à 43,7. Un point de marge absorbe ce bruit sans rien céder — un bouton
/// réellement à 40 pt reste pris.
private let bruitDeMesure: CGFloat = 1

/// `@MainActor` : sous la concurrence stricte de Swift 6, `snapshot()` est
/// isolé au main actor, comme tout XCUITest.
@MainActor
final class AuditAccessibilite: XCTestCase {

    /// Les écrans qui, ensemble, montrent chaque sorte de commande.
    /// `z00` est la seule zone qui porte le chauffage, `z03` la seule qui
    /// réunisse éclairages variables, volets et mesures.
    private static let parcours: [(nom: String, zone: String?)] = [
        ("l'accueil", nil), ("le salon", "z03"), ("le général", "z00"),
    ]

    /// Une commande relevée, figée : plus aucun aller-retour vers l'app.
    private struct Commande: Hashable {
        let nom: String
        let identifiant: String
        let cadre: CGRect
        var trop: Bool {
            cadre.width < cibleMin - bruitDeMesure || cadre.height < cibleMin - bruitDeMesure
        }
    }

    override func setUp() { continueAfterFailure = true }

    private func lancer(taille: String? = nil, zone: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        if let taille {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", taille]
        }
        if let zone { app.launchArguments += ["-zone", zone] }
        app.launch()
        // La configuration arrive du serveur : rien n'est mesurable avant.
        XCTAssertTrue(app.buttons.element(boundBy: 0).waitForExistence(timeout: 25),
                      "L'app n'a affiché aucune commande — serveur injoignable ?")
        return app
    }

    // MARK: Le relevé

    /// Les commandes visibles à cet instant, prises en un seul instantané.
    private func instantane(_ app: XCUIApplication) -> Set<Commande> {
        guard let racine = try? app.snapshot() else { return [] }
        let ecran = app.frame
        var trouvees: Set<Commande> = []

        func descendre(_ n: XCUIElementSnapshot) {
            if n.elementType == .button {
                let c = n.frame
                // Hors écran = hors sujet : on mesure ce qu'on peut toucher.
                if c.width > 0, c.height > 0, c.intersects(ecran) {
                    trouvees.insert(Commande(nom: n.label, identifiant: n.identifier, cadre: c))
                }
            }
            n.children.forEach(descendre)
        }
        descendre(racine)
        return trouvees
    }

    /// Descend la page en relevant à chaque palier.
    ///
    /// Sans ce défilement l'audit ne mesurait que le premier tiers de la page
    /// et se déclarait satisfait — un test sans portée est pire que pas de test.
    private func releve(_ app: XCUIApplication) -> Set<Commande> {
        var tout: Set<Commande> = []
        for passage in 0..<8 {
            tout.formUnion(instantane(app))
            let page = app.scrollViews.element(boundBy: 0)
            guard passage < 7, page.exists else { break }
            page.swipeUp(velocity: .slow)
            // Mesurer pendant l'inertie donne des tailles fausses : une cible
            // de 44 pt s'y relevait à 43. On attend que la page se pose.
            Thread.sleep(forTimeInterval: 0.7)
        }
        return tout
    }

    /// Reprend une mesure après un instant : un élément relevé pendant une
    /// transition de vue disparaît, un vrai défaut reste.
    private func confirme(_ suspects: Set<Commande>, dans app: XCUIApplication) -> [Commande] {
        guard !suspects.isEmpty else { return [] }
        Thread.sleep(forTimeInterval: 1.2)
        let seconde = instantane(app)
        return suspects.filter { seconde.contains($0) }
    }

    // MARK: Les commandes ont un nom

    func testChaqueCommandePorteUnNom() {
        for etape in Self.parcours {
            let app = lancer(zone: etape.zone)
            let anonymes = releve(app).filter {
                $0.nom.trimmingCharacters(in: .whitespaces).isEmpty
            }
            let reels = confirme(anonymes, dans: app)
            XCTAssertTrue(reels.isEmpty,
                          "\(reels.count) commande(s) sans nom sur \(etape.nom) : muettes pour VoiceOver.")
            app.terminate()
        }
    }

    // MARK: Les cibles sont assez grandes

    func testChaqueCibleAtteint44Points() {
        for etape in Self.parcours {
            let app = lancer(zone: etape.zone)
            // Les pièces du plan sont exemptées : chacune est doublée, juste
            // en dessous, par une carte de pièce en pleine taille. Les
            // agrandir les ferait se chevaucher et désigner la mauvaise pièce.
            let suspectes = releve(app).filter { $0.identifiant != "plan-piece" && $0.trop }
            let trop = confirme(suspectes, dans: app)
                .map { "« \($0.nom) » \(Int($0.cadre.width))×\(Int($0.cadre.height))" }
            XCTAssertTrue(trop.isEmpty,
                          "Cible(s) sous 44 pt sur \(etape.nom) : \(trop.sorted().joined(separator: ", "))")
            app.terminate()
        }
    }

    // MARK: Les réglages sont opérables sans le geste

    /// Une tuile qui se règle doit annoncer sa valeur : sans valeur, VoiceOver
    /// n'a rien à incrémenter, et le réglage reste hors de portée.
    func testLesTuilesReglablesAnnoncentLeurValeur() {
        let app = lancer(zone: "z03")
        guard let racine = try? app.snapshot() else {
            return XCTFail("Aucun instantané de l'arbre d'accessibilité.")
        }
        var valeurs: [String] = []
        func descendre(_ n: XCUIElementSnapshot) {
            if let v = n.value as? String, !v.trimmingCharacters(in: .whitespaces).isEmpty {
                valeurs.append(v)
            }
            n.children.forEach(descendre)
        }
        descendre(racine)
        XCTAssertGreaterThan(valeurs.count, 0,
                             "Aucun élément n'expose de valeur : rien n'est réglable à VoiceOver.")
    }

    // MARK: La mise en page tient en très gros caractères

    /// Mesuré dans une pièce : l'accueil porte un rail de scènes qui défile
    /// horizontalement, donc volontairement plus large que l'écran.
    func testLaMiseEnPageTientEnTresGrosCaracteres() {
        let app = lancer(taille: "UICTContentSizeCategoryAccessibilityXXXL", zone: "z03")
        let largeur = app.frame.width
        let debordantes = releve(app).filter { $0.cadre.minX < -1 || $0.cadre.maxX > largeur + 1 }
        let debordent = confirme(debordantes, dans: app).map { "« \($0.nom) »" }
        XCTAssertTrue(debordent.isEmpty,
                      "Déborde(nt) de l'écran en gros caractères : \(debordent.sorted().joined(separator: ", "))")
    }

    /// La preuve que Dynamic Type est branché : le même texte doit occuper
    /// plus de place. Avant correction, les deux tailles étaient identiques.
    func testLeTexteGrandit() {
        let petit = lancer(taille: "UICTContentSizeCategoryLarge")
        let refPetit = petit.staticTexts["resume-maison"]
        XCTAssertTrue(refPetit.waitForExistence(timeout: 25))
        let hPetit = refPetit.frame.height
        petit.terminate()

        let grand = lancer(taille: "UICTContentSizeCategoryAccessibilityXXXL")
        let refGrand = grand.staticTexts["resume-maison"]
        XCTAssertTrue(refGrand.waitForExistence(timeout: 25))
        let hGrand = refGrand.frame.height

        XCTAssertGreaterThan(hGrand, hPetit * 1.5,
                             "Le texte ne suit pas la taille système : \(hPetit) pt → \(hGrand) pt.")
    }
}
