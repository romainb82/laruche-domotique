import Foundation
import Network

/// Trouve la maison sur le réseau local.
///
/// Coder une adresse IP en dur est le premier piège : elle change au premier
/// redémarrage de la box. Le serveur s'annonce en Bonjour, l'app l'écoute.
///
/// À distance, rien ne change : le tunnel WireGuard place le téléphone sur le
/// réseau de la maison, et la même découverte fonctionne. L'app ne sait pas si
/// elle est dans le salon ou à l'autre bout du pays.
public actor Discovery {
    public static let serviceType = "_domotique._tcp"

    private var browser: NWBrowser?

    public init() {}

    /// Cherche le serveur, et rend son adresse.
    ///
    /// Le délai est porté par la continuation elle-même. Une première version
    /// le confiait à un groupe de tâches : le minuteur expirait bien, mais le
    /// groupe attendait toujours la tâche Bonjour restée en suspens, et la
    /// fonction ne rendait jamais la main. Une découverte qui bloque est pire
    /// qu'une découverte qui échoue.
    public func find(timeout: TimeInterval = 5) async throws -> URL {
        try await withCheckedThrowingContinuation { suite in
            let parametres = NWParameters()
            parametres.includePeerToPeer = false
            // Avec le TXT : le serveur y publie son nom d'hôte réel. Le nom du
            // service Bonjour (« maison ») n'est PAS un nom d'hôte : les
            // confondre mène à chercher un « maison.local » qui n'existe pas.
            let browser = NWBrowser(
                for: .bonjourWithTXTRecord(type: Self.serviceType, domain: nil),
                using: parametres
            )
            self.browser = browser

            // Deux fermetures concurrentes peuvent répondre : la découverte et
            // l'échec. Une continuation reprise deux fois plante le programme,
            // d'où ce verrou plutôt qu'un simple booléen.
            let garde = Garde()

            browser.browseResultsChangedHandler = { resultats, _ in
                for r in resultats {
                    guard case .bonjour(let txt) = r.metadata,
                          let hote = txt["host"], !hote.isEmpty else { continue }
                    let port = txt["port"].flatMap(Int.init) ?? 3001
                    guard let url = URL(string: "http://\(hote):\(port)") else { continue }
                    guard garde.prendre() else { return }
                    browser.cancel()
                    // On passe par le nom mDNS, jamais par une IP : celle-ci
                    // change au premier redémarrage de la box.
                    suite.resume(returning: url)
                    return
                }
            }
            browser.stateUpdateHandler = { etat in
                if case .failed = etat, garde.prendre() {
                    suite.resume(throwing: DomoError.introuvable)
                }
            }
            browser.start(queue: .global(qos: .userInitiated))

            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                guard garde.prendre() else { return }
                browser.cancel()
                suite.resume(throwing: DomoError.introuvable)
            }
        }
    }

}

/// Laisse passer un seul appelant. Le premier gagne, les suivants renoncent.
private final class Garde: @unchecked Sendable {
    private let verrou = NSLock()
    private var pris = false

    func prendre() -> Bool {
        verrou.lock()
        defer { verrou.unlock() }
        if pris { return false }
        pris = true
        return true
    }
}

/// Où joindre la maison.
///
/// Trois sources, dans cet ordre : ce que l'utilisateur a réglé à la main,
/// ce que Bonjour a trouvé, puis le repli de développement.
public struct Endpoint: Sendable, Equatable, Codable {
    public let url: URL
    public let origine: Origine

    public enum Origine: String, Sendable, Codable {
        case manuel, bonjour, developpement

        public var label: String {
            switch self {
            case .manuel: "adresse saisie"
            case .bonjour: "trouvée sur le réseau"
            case .developpement: "serveur de développement"
            }
        }
    }

    public init(url: URL, origine: Origine) {
        self.url = url
        self.origine = origine
    }

    public static let developpement = Endpoint(
        url: URL(string: "http://localhost:3001")!, origine: .developpement
    )
}
