import XCTest
@testable import DomoKit

/// Les tests de contrat.
///
/// Ils ne vérifient pas du Swift : ils vérifient que le Swift et le TypeScript
/// racontent la même histoire. Chaque test interroge le VRAI serveur et décode
/// sa vraie réponse — donc toute dérive du contrat casse ici, au moment de
/// compiler, plutôt que sur le téléphone six mois plus tard.
///
/// Ils sont ignorés si le cerveau ne tourne pas : on ne veut pas d'une suite
/// rouge parce qu'on a oublié `npm run dev`.
@MainActor
final class ContractTests: XCTestCase {

    static let base = URL(string: "http://localhost:3001")!
    private var client: DomoClient { DomoClient(base: Self.base) }

    /// Le serveur est-il joignable ? Sinon on saute, sans crier.
    private func exigerCerveau() async throws {
        var r = URLRequest(url: Self.base.appending(path: "/api/state"))
        r.timeoutInterval = 2
        guard let (_, reponse) = try? await URLSession.shared.data(for: r),
              (reponse as? HTTPURLResponse)?.statusCode == 200 else {
            throw XCTSkip("Le cerveau ne tourne pas — lance `npm run dev` d'abord.")
        }
    }

    // MARK: Le contrat de données

    func testConfigurationSeDecodeEntierement() async throws {
        try await exigerCerveau()
        let config = try await client.config()

        XCTAssertFalse(config.zones.isEmpty, "la maison doit avoir des zones")
        XCTAssertFalse(config.devices.isEmpty, "la maison doit avoir des équipements")
        XCTAssertLessThan(config.heating.minSetpoint, config.heating.maxSetpoint)

        // Le plan : c'est ce qui permettra de dessiner la maison dans l'app.
        let surPlan = config.zones.filter(\.isOnPlan)
        XCTAssertGreaterThanOrEqual(surPlan.count, 10, "le plan doit porter la plupart des pièces")

        // Chaque équipement pointe vers une zone qui existe.
        let zoneIds = Set(config.zones.map(\.id))
        let orphelins = config.devices.filter { !zoneIds.contains($0.zoneId) }
        XCTAssertTrue(orphelins.isEmpty, "équipements orphelins : \(orphelins.map(\.id))")

        print("  · \(config.zones.count) zones, \(config.devices.count) équipements, \(config.scenes?.count ?? 0) scènes")
    }

    func testToutesLesCapacitesSontComprises() async throws {
        try await exigerCerveau()
        let snap = try await client.snapshot()
        XCTAssertFalse(snap.states.isEmpty)

        // Si le serveur ajoute une famille de capacité, le décodage lève et ce
        // test tombe — c'est exactement le but.
        var vues = Set<String>()
        for etat in snap.states {
            for cap in etat.caps {
                switch cap {
                case .power: vues.insert("switch")
                case .dim: vues.insert("dim")
                case .cover: vues.insert("cover")
                case .climate: vues.insert("climate")
                case .sensor: vues.insert("sensor")
                }
            }
        }
        XCTAssertTrue(vues.contains("switch"))
        XCTAssertTrue(vues.contains("cover"))
        XCTAssertTrue(vues.contains("sensor"))
        XCTAssertTrue(vues.contains("climate"))
        print("  · capacités reçues : \(vues.sorted().joined(separator: ", "))")
    }

    // MARK: Le comportement

    func testUneCommandeFaitBougerLaMaison() async throws {
        try await exigerCerveau()
        let config = try await client.config()
        let lampe = try XCTUnwrap(
            config.devices.first { $0.type == .light && $0.zoneId == "z01" },
            "il faut une lampe simple pour ce test"
        )

        try await client.send(.power(on: true), to: lampe.id)
        try await Task.sleep(for: .milliseconds(700))
        var snap = try await client.snapshot()
        var etat = try XCTUnwrap(snap.states.first { $0.id == lampe.id })
        XCTAssertTrue(etat.isOn, "la lampe doit être allumée")

        try await client.send(.power(on: false), to: lampe.id)
        try await Task.sleep(for: .milliseconds(700))
        snap = try await client.snapshot()
        etat = try XCTUnwrap(snap.states.first { $0.id == lampe.id })
        XCTAssertFalse(etat.isOn)
    }

    /// LA règle du projet : entre la commande et l'arrivée, l'app doit pouvoir
    /// afficher « en cours » plutôt que de prétendre que c'est fait.
    func testUnVoletMetDuTempsEtLAppLeSait() async throws {
        try await exigerCerveau()
        let config = try await client.config()
        // On prend le volet d'une chambre : les scènes de test pilotent les
        // pièces de vie, et un test qui partage un équipement avec un autre
        // test n'est pas un test, c'est un tirage au sort.
        let volet = try XCTUnwrap(
            config.devices.first { $0.type == .cover && $0.zoneId == "z09" }
                ?? config.devices.first { $0.type == .cover }
        )

        // On attend qu'il soit à l'arrêt avant de commencer à chronométrer.
        try await attendreImmobile(volet.id)
        try await client.send(.cover(position: 100), to: volet.id)
        try await attendreImmobile(volet.id)

        try await client.send(.cover(position: 0), to: volet.id)
        try await Task.sleep(for: .seconds(3))

        let snap = try await client.snapshot()
        let etat = try XCTUnwrap(snap.states.first { $0.id == volet.id })
        XCTAssertTrue(
            etat.pending || etat.coverMoving != nil,
            "le volet doit se signaler en mouvement (pending=\(etat.pending), moving=\(String(describing: etat.coverMoving)))"
        )
        let position = try XCTUnwrap(etat.coverPosition)
        XCTAssertTrue(position > 0 && position < 100, "position intermédiaire attendue, reçu \(position)")
        print("  · volet à \(position) %, en mouvement : \(String(describing: etat.coverMoving))")
    }

    /// Attend qu'un volet cesse de bouger — au plus 40 s, soit largement plus
    /// qu'une course complète.
    private func attendreImmobile(_ deviceId: String) async throws {
        for _ in 0..<80 {
            let snap = try await client.snapshot()
            let e = snap.states.first { $0.id == deviceId }
            if e?.coverMoving == nil && e?.pending == false { return }
            try await Task.sleep(for: .milliseconds(500))
        }
    }

    func testLeFluxTempsReelPousseLesEtats() async throws {
        try await exigerCerveau()
        let connexion = LiveConnection(base: Self.base)

        let compteur = Compteur()
        let ecoute = Task {
            for await event in await connexion.events() {
                switch event {
                case .snapshot: await compteur.instantaneRecu()
                case .state: await compteur.pousse()
                default: break
                }
            }
        }

        try await Task.sleep(for: .milliseconds(900))
        let config = try await client.config()
        if let lampe = config.devices.first(where: { $0.type == .light }) {
            try await client.send(.power(on: true), to: lampe.id)
            try await Task.sleep(for: .milliseconds(400))
            try await client.send(.power(on: false), to: lampe.id)
        }
        try await Task.sleep(for: .seconds(7))

        ecoute.cancel()
        await connexion.stop()

        let (instantane, pousses) = await compteur.bilan()
        XCTAssertTrue(instantane, "le serveur doit envoyer un instantané à la connexion")
        XCTAssertGreaterThan(pousses, 0, "aucun état poussé en 8 secondes")
        print("  · \(pousses) états poussés par le flux temps réel")
    }

    func testUneSceneSAppliqueEtRendDesComptes() async throws {
        try await exigerCerveau()
        let config = try await client.config()
        let scenes = try XCTUnwrap(config.scenes, "le serveur doit exposer des scènes")
        let scene = try XCTUnwrap(scenes.first { $0.id == "depart" } ?? scenes.first)

        let resultat = try await client.applyScene(scene.id)
        XCTAssertGreaterThan(resultat.total, 0, "une scène vide ne sert à rien")
        XCTAssertEqual(resultat.echecs, 0, "\(resultat.echecs) équipements n'ont pas répondu")
        print("  · « \(resultat.scene) » a piloté \(resultat.total) équipements")
    }

    func testLesCanauxRemontentLeurSante() async throws {
        try await exigerCerveau()
        let snap = try await client.snapshot()

        XCTAssertFalse(snap.connections.isEmpty)
        let simulateur = try XCTUnwrap(snap.connections.first { $0.id == "sim" })
        XCTAssertEqual(simulateur.state, .connected)
        XCTAssertGreaterThan(simulateur.devices, 0)
        print("  · \(snap.connections.count) canal(aux), simulateur : \(simulateur.devices) équipements")
    }

    // MARK: L'état observable

    func testLeStoreSeChargeEtSuit() async throws {
        try await exigerCerveau()
        let store = HouseStore(endpoint: Endpoint(url: Self.base, origine: .manuel))
        // On ne cherche pas sur le réseau : l'adresse est imposée par le test.
        await store.demarrer(decouvrir: false)

        XCTAssertNotNil(store.config)
        XCTAssertFalse(store.zones.isEmpty)
        XCTAssertFalse(store.states.isEmpty)

        let piece = try XCTUnwrap(store.zones.first { !store.devices(dans: $0.id).isEmpty })
        XCTAssertFalse(store.devices(dans: piece.id).isEmpty)
        print("  · store : \(store.zones.count) zones, \(store.states.count) états, « \(piece.label) » chargée")
    }
}

/// Petit compteur isolé : les fermetures du flux tournent hors de l'acteur
/// principal, on ne peut pas y muter des variables locales.
private actor Compteur {
    private var instantane = false
    private var pousses = 0

    func instantaneRecu() { instantane = true }
    func pousse() { pousses += 1 }
    func bilan() -> (Bool, Int) { (instantane, pousses) }
}
