import Foundation

/// Le flux temps réel.
///
/// Même règle que sur le web : l'état affiché vient TOUJOURS d'ici, jamais du
/// geste de l'utilisateur. Un volet qui bouge se voit bouger.
///
/// La reconnexion est automatique et silencieuse — une maison ne doit pas
/// rester muette parce qu'un serveur a redémarré ou qu'on a changé de réseau.
public actor LiveConnection {
    public enum Event: Sendable {
        case snapshot(states: [DeviceState], connections: [ConnectionStatus])
        case state(DeviceState)
        case connections([ConnectionStatus])
        case reloaded
        case connected
        case disconnected
    }

    private let base: URL
    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var continuation: AsyncStream<Event>.Continuation?
    private var arrete = false
    private var tentatives = 0

    public init(base: URL, session: URLSession = .shared) {
        self.base = base
        self.session = session
    }

    public func events() -> AsyncStream<Event> {
        AsyncStream { continuation in
            self.continuation = continuation
            continuation.onTermination = { _ in Task { await self.stop() } }
            Task { await self.connect() }
        }
    }

    public func stop() {
        arrete = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    // MARK: Privé

    private func connect() async {
        guard !arrete else { return }

        var composants = URLComponents(url: base.appending(path: "/ws"), resolvingAgainstBaseURL: false)
        composants?.scheme = base.scheme == "https" ? "wss" : "ws"
        guard let url = composants?.url else { return }

        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        // On n'annonce PAS « connecté » ici : ouvrir une socket ne prouve rien.
        // C'est le premier message reçu qui fait foi — sinon l'app afficherait
        // un voyant vert devant un serveur muet.
        await receive()
    }

    private func receive() async {
        guard let task, !arrete else { return }
        do {
            let message = try await task.receive()
            if tentatives != 0 { tentatives = 0 }
            continuation?.yield(.connected)
            if case .string(let texte) = message, let data = texte.data(using: .utf8) {
                decode(data)
            }
            await receive()
        } catch {
            guard !arrete else { return }
            continuation?.yield(.disconnected)
            await reconnect()
        }
    }

    /// Réessai avec un délai qui s'allonge, plafonné : on ne martèle pas un
    /// serveur éteint, mais on revient vite quand il est juste redémarré.
    private func reconnect() async {
        tentatives = min(tentatives + 1, 5)
        let delai = UInt64(min(pow(2.0, Double(tentatives)), 20) * 1_000_000_000 / 2)
        try? await Task.sleep(nanoseconds: delai)
        await connect()
    }

    private func decode(_ data: Data) {
        struct Enveloppe: Decodable {
            let type: String
            let state: DeviceState?
            let states: [DeviceState]?
            let connections: [ConnectionStatus]?
        }
        guard let e = try? JSONDecoder().decode(Enveloppe.self, from: data) else { return }

        switch e.type {
        case "snapshot":
            continuation?.yield(.snapshot(states: e.states ?? [], connections: e.connections ?? []))
        case "reload":
            continuation?.yield(.snapshot(states: e.states ?? [], connections: e.connections ?? []))
            continuation?.yield(.reloaded)
        case "state":
            if let s = e.state { continuation?.yield(.state(s)) }
        case "connections":
            continuation?.yield(.connections(e.connections ?? []))
        default:
            break
        }
    }
}
