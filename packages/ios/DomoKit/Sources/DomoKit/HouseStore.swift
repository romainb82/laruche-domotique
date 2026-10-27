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

    private var client: DomoClient
    private var connexion: LiveConnection?
    private var boucle: Task<Void, Never>?

    public init(endpoint: Endpoint = .developpement) {
        self.endpoint = endpoint
        self.client = DomoClient(base: endpoint.url)
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
            client = DomoClient(base: trouve)
        }
        await charger()
        ecouter()
    }

    /// L'adresse répond-elle ? Deux secondes suffisent sur un réseau local.
    static func repond(_ url: URL) async -> Bool {
        var r = URLRequest(url: url.appending(path: "/api/state"))
        r.timeoutInterval = 2
        guard let (_, reponse) = try? await URLSession.shared.data(for: r) else { return false }
        return (reponse as? HTTPURLResponse)?.statusCode == 200
    }

    public func basculer(vers nouveau: Endpoint) {
        guard nouveau != endpoint else { return }
        boucle?.cancel()
        endpoint = nouveau
        client = DomoClient(base: nouveau.url)
        Task { await charger(); ecouter() }
    }

    public func charger() async {
        do {
            config = try await client.config()
            let snap = try await client.snapshot()
            states = Dictionary(uniqueKeysWithValues: snap.states.map { ($0.id, $0) })
            connections = snap.connections
            erreur = nil
        } catch {
            erreur = (error as? DomoError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func ecouter() {
        let connexion = LiveConnection(base: endpoint.url)
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

    public func envoyer(_ command: Command, a deviceId: String) async {
        do { try await client.send(command, to: deviceId) }
        catch { erreur = (error as? DomoError)?.errorDescription ?? error.localizedDescription }
    }

    public func envoyer(_ command: Command, a deviceIds: [String]) async {
        guard !deviceIds.isEmpty else { return }
        do { try await client.sendBulk(command, to: deviceIds) }
        catch { erreur = (error as? DomoError)?.errorDescription ?? error.localizedDescription }
    }

    @discardableResult
    public func jouer(scene: SceneConfig) async -> DomoClient.SceneResult? {
        do { return try await client.applyScene(scene.id) }
        catch {
            erreur = (error as? DomoError)?.errorDescription ?? error.localizedDescription
            return nil
        }
    }
}
