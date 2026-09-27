import Foundation

/// Le client du cerveau.
///
/// Volontairement mince : le serveur porte toute l'intelligence, l'app ne fait
/// que demander et écouter. Aucune mise à jour optimiste ici non plus — on
/// envoie la commande, et on attend que le serveur dise ce qui s'est passé.
public actor DomoClient {
    public let base: URL
    private let session: URLSession

    public init(base: URL, session: URLSession = .shared) {
        self.base = base
        self.session = session
    }

    // MARK: Lecture

    public func config() async throws -> HouseConfig {
        try await get("/api/config")
    }

    public func snapshot() async throws -> Snapshot {
        try await get("/api/state")
    }

    public struct Snapshot: Decodable, Sendable {
        public let states: [DeviceState]
        public let connections: [ConnectionStatus]
    }

    public func history(deviceId: String, hours: Int = 24) async throws -> [Point] {
        let encoded = deviceId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? deviceId
        let reponse: HistoryResponse = try await get("/api/history?device=\(encoded)&hours=\(hours)")
        return reponse.points
    }

    public struct Point: Decodable, Sendable { public let at: Double; public let value: Double }
    private struct HistoryResponse: Decodable { let points: [Point] }

    // MARK: Écriture

    @discardableResult
    public func send(_ command: Command, to deviceId: String) async throws -> DeviceState? {
        let encoded = deviceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? deviceId
        let reponse: CommandResponse = try await post("/api/devices/\(encoded)/command", body: command)
        return reponse.state
    }

    private struct CommandResponse: Decodable { let ok: Bool; let state: DeviceState? }

    /// Action groupée — éteindre une pièce, fermer tous les volets.
    public func sendBulk(_ command: Command, to deviceIds: [String]) async throws {
        struct Corps: Encodable { let deviceIds: [String]; let command: Command }
        let _: BulkResponse = try await post("/api/commands/bulk",
                                             body: Corps(deviceIds: deviceIds, command: command))
    }

    private struct BulkResponse: Decodable { let ok: Bool; let failed: Int }

    /// Joue une scène. Le retour dit combien d'équipements n'ont pas répondu —
    /// une scène à moitié appliquée doit se voir.
    @discardableResult
    public func applyScene(_ id: String) async throws -> SceneResult {
        try await post("/api/scenes/\(id)/apply", body: EmptyBody())
    }

    public struct SceneResult: Decodable, Sendable {
        public let ok: Bool
        public let scene: String
        public let total: Int
        public let echecs: Int
    }

    private struct EmptyBody: Encodable {}

    // MARK: Transport

    private func get<T: Decodable>(_ path: String) async throws -> T {
        var request = URLRequest(url: base.appending(path: path))
        request.timeoutInterval = 8
        return try await run(request)
    }

    private func post<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
        var request = URLRequest(url: base.appending(path: path))
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await run(request)
    }

    private func run<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw DomoError.reseau }
        guard (200..<300).contains(http.statusCode) else {
            throw DomoError.serveur(code: http.statusCode, message: Self.message(dans: data))
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw DomoError.contrat(String(describing: error))
        }
    }

    /// Le serveur renvoie des messages écrits pour un humain : on les garde.
    private static func message(dans data: Data) -> String? {
        struct Erreur: Decodable { let error: String? }
        return (try? JSONDecoder().decode(Erreur.self, from: data))?.error
    }
}

public enum DomoError: Error, LocalizedError, Sendable {
    case reseau
    case serveur(code: Int, message: String?)
    /// Le serveur a répondu quelque chose que l'app ne sait pas lire.
    case contrat(String)
    case introuvable

    public var errorDescription: String? {
        switch self {
        case .reseau:
            "Maison injoignable."
        case .serveur(let code, let message):
            message ?? "Le serveur a répondu \(code)."
        case .contrat:
            "Le serveur parle une version que cette app ne comprend pas."
        case .introuvable:
            "Aucune maison trouvée sur le réseau."
        }
    }
}
