import Foundation
import Observation

/// L'état vivant de la maison, côté app.
///
/// Les deux règles du hub serveur sont tenues ici aussi :
///
///  1. l'état vient TOUJOURS du flux temps réel, jamais du geste ;
///  2. entre l'envoi d'une commande et sa confirmation, l'équipement est
///     `pending` : l'interface affiche « en cours », un troisième état.
@MainActor
@Observable
public final class HouseStore {
    public private(set) var config: HouseConfig?
    public private(set) var states: [String: DeviceState] = [:]
    public private(set) var connections: [ConnectionStatus] = []
    public private(set) var live = false
    public private(set) var erreur: String?

    public private(set) var endpoint: Endpoint

    // MARK: Session

    /// Qui est connecté. `nil` = personne : l'app montre la porte d'entrée.
    public private(set) var compte: Compte?
    /// Vrai tant qu'on n'a pas encore demandé au serveur si le jeton tient.
    public private(set) var sessionInconnue = true
    /// Faux tant qu'aucun compte n'existe : la maison demandera d'en créer un.
    public private(set) var installe = true
    public private(set) var habitants: [Habitant] = []
    public var authentifie: Bool { compte != nil }

    private var client: DomoClient
    private var connexion: LiveConnection?
    private var boucle: Task<Void, Never>?

    public init(endpoint: Endpoint = .developpement) {
        self.endpoint = endpoint
        self.client = DomoClient(base: endpoint.url, jeton: Trousseau.lire())
    }

    /// Le compte peut-il au moins ceci ? Pour masquer ce qu'un rôle n'a pas le droit de faire.
    public func peut(_ minimum: Compte.Role) -> Bool {
        guard let compte else { return false }
        return compte.role >= minimum
    }

    /// Le jeton rangé tient-il encore ? Sinon, qui habite ici ?
    public func verifierSession() async {
        defer { sessionInconnue = false }
        do {
            let etat = try await client.etatAuth()
            installe = etat.installe
            compte = etat.compte
            if compte == nil {
                Trousseau.effacer()
                await client.poser(jeton: nil)
                habitants = (try? await client.habitants()) ?? []
            }
        } catch {
            // Serveur injoignable : on ne prétend pas que la personne est
            // connectée, et le bandeau dira que la maison ne répond pas.
            compte = nil
            erreur = (error as? DomoError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Message de refus, ou `nil` si la porte s'est ouverte.
    public func connexion(identifiant: String, motDePasse: String) async -> String? {
        await ouvrir { try await self.client.connexion(identifiant: identifiant, motDePasse: motDePasse) }
    }

    public func connexion(compteId: String, motDePasse: String) async -> String? {
        await ouvrir { try await self.client.connexion(compteId: compteId, motDePasse: motDePasse) }
    }

    public func premierCompte(identifiant: String, nom: String, motDePasse: String) async -> String? {
        await ouvrir { try await self.client.premierCompte(identifiant: identifiant, nom: nom, motDePasse: motDePasse) }
    }

    private func ouvrir(_ appel: () async throws -> DomoClient.Ouverture) async -> String? {
        do {
            let o = try await appel()
            Trousseau.ecrire(o.jeton)
            compte = o.compte
            installe = true
            erreur = nil
            await charger()
            ecouter()
            return nil
        } catch {
            return (error as? DomoError)?.errorDescription ?? error.localizedDescription
        }
    }

    public func deconnexion() async {
        boucle?.cancel()
        await connexion?.stop()
        await client.deconnexion()
        Trousseau.effacer()
        compte = nil
        states = [:]
        connections = []
        config = nil
        live = false
        habitants = (try? await client.habitants()) ?? []
    }

    /// Le serveur a refusé le jeton : on oublie la session et on retourne à la porte.
    private func sessionPerdue() {
        boucle?.cancel()
        Trousseau.effacer()
        Task { await client.poser(jeton: nil) }
        compte = nil
        live = false
        Task { habitants = (try? await client.habitants()) ?? [] }
    }

    // MARK: Cycle de vie

    /// Cherche la maison sur le réseau, puis se connecte. En cas d'échec on
    /// garde l'adresse précédente : mieux vaut une app qui insiste qu'une app
    /// qui abandonne parce que le Wi-Fi a hoqueté.
    public func demarrer(decouvrir: Bool = true) async {
        if decouvrir, endpoint.origine != .manuel,
           let trouve = try? await Discovery().find(),
           await Self.repond(trouve) {
            // On ne bascule que si l'adresse trouvée répond vraiment : une
            // annonce Bonjour peut survivre au serveur qui l'a émise.
            endpoint = Endpoint(url: trouve, origine: .bonjour)
            client = DomoClient(base: trouve, jeton: Trousseau.lire())
        }
        await verifierSession()
        guard authentifie else { return }
        await charger()
        ecouter()
    }

    /// L'adresse répond-elle ? Deux secondes suffisent sur un réseau local.
    /// On sonde la route d'état de l'authentification : elle est ouverte, et
    /// répond 200 que l'on soit connecté ou non.
    static func repond(_ url: URL) async -> Bool {
        var r = URLRequest(url: url.appending(path: "/api/auth/etat"))
        r.timeoutInterval = 2
        guard let (_, reponse) = try? await URLSession.shared.data(for: r) else { return false }
        return (reponse as? HTTPURLResponse)?.statusCode == 200
    }

    public func basculer(vers nouveau: Endpoint) {
        guard nouveau != endpoint else { return }
        boucle?.cancel()
        endpoint = nouveau
        // Une session ne vaut que pour UN serveur : on repart de la porte.
        Trousseau.effacer()
        client = DomoClient(base: nouveau.url)
        compte = nil
        Task { await verifierSession() }
    }

    public func charger() async {
        do {
            config = try await client.config()
            let snap = try await client.snapshot()
            states = Dictionary(uniqueKeysWithValues: snap.states.map { ($0.id, $0) })
            connections = snap.connections
            erreur = nil
        } catch DomoError.nonAuthentifie {
            sessionPerdue()
        } catch {
            erreur = (error as? DomoError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func ecouter() {
        let connexion = LiveConnection(base: endpoint.url, jeton: Trousseau.lire())
        self.connexion = connexion
        boucle?.cancel()
        boucle = Task { [weak self] in
            for await event in await connexion.events() {
                guard let self, !Task.isCancelled else { return }
                self.appliquer(event)
            }
        }
    }

    private func appliquer(_ event: LiveConnection.Event) {
        switch event {
        case .snapshot(let s, let c):
            states = Dictionary(uniqueKeysWithValues: s.map { ($0.id, $0) })
            connections = c
            live = true
            erreur = nil
        case .state(let s):
            states[s.id] = s
        case .connections(let c):
            connections = c
        case .reloaded:
            Task { await charger() }
        case .connected:
            live = true
        case .disconnected:
            live = false
        case .nonAuthentifie:
            sessionPerdue()
        }
    }

    // MARK: Lecture

    public var zones: [Zone] { (config?.zones ?? []).sorted { $0.order < $1.order } }
    public var scenes: [SceneConfig] { (config?.scenes ?? []).sorted { $0.order < $1.order } }
    public var devices: [Device] { config?.devices ?? [] }

    public func zone(_ id: String) -> Zone? { zones.first { $0.id == id } }

    public func devices(dans zoneId: String) -> [Device] {
        devices.filter { $0.zoneId == zoneId }.sorted { $0.order < $1.order }
    }

    public func state(_ deviceId: String) -> DeviceState? { states[deviceId] }

    /// Une valeur périmée ne pilote rien, et ne s'affiche pas comme une valeur.
    public func estJoignable(_ deviceId: String) -> Bool {
        states[deviceId]?.health.isActionable ?? false
    }

    // MARK: Actions

    /// Règle 2, tenue ici pour toutes les vues : un équipement périmé ou déjà
    /// « en cours » ne reçoit pas de commande, et on le dit.
    private func pilotable(_ deviceId: String) -> String? {
        guard let s = states[deviceId], s.health.isActionable else {
            return "Cet équipement ne donne plus de nouvelles : on ne le pilote pas à l’aveugle."
        }
        if s.pending { return "Commande déjà en cours, on attend la réponse du matériel." }
        return nil
    }

    private func retenir(_ error: Error) {
        if case DomoError.nonAuthentifie = error { sessionPerdue(); return }
        erreur = (error as? DomoError)?.errorDescription ?? error.localizedDescription
    }

    public func envoyer(_ command: Command, a deviceId: String) async {
        if let refus = pilotable(deviceId) { erreur = refus; return }
        do { try await client.send(command, to: deviceId) }
        catch { retenir(error) }
    }

    public func envoyer(_ command: Command, a deviceIds: [String]) async {
        let retenus = deviceIds.filter { pilotable($0) == nil }
        guard !retenus.isEmpty else {
            if !deviceIds.isEmpty { erreur = "Aucun de ces équipements ne peut être piloté pour le moment." }
            return
        }
        do { try await client.sendBulk(command, to: retenus) }
        catch { retenir(error) }
    }

    @discardableResult
    public func jouer(scene: SceneConfig) async -> DomoClient.SceneResult? {
        do { return try await client.applyScene(scene.id) }
        catch {
            retenir(error)
            return nil
        }
    }
}
